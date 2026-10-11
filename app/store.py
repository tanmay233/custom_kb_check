from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from uuid import uuid4

import kuzu
from fastapi import HTTPException

from .models import GraphSave


def now():
    return datetime.now(timezone.utc).isoformat()


class GraphStore:
    """One embedded Kuzu database; every record is scoped to its owning graph."""

    def __init__(self, directory: Path, memory_mb=512):
        directory.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        try:
            self.db = kuzu.Database(str(directory / "knowledge.kuzu"), buffer_pool_size=memory_mb * 1024**2)
        except RuntimeError as exc:
            if "Could not set lock on file" in str(exc):
                raise RuntimeError(
                    f"Kùzu could not lock {directory / 'knowledge.kuzu'}. "
                    "Another Graph Studio/Uvicorn process is using this database. "
                    "Stop the other server, or start this server with a different KG_DATA_DIR. "
                    "Do not delete database files while another process is running."
                ) from exc
            raise
        self.conn = kuzu.Connection(self.db)
        for statement in [
            "CREATE NODE TABLE IF NOT EXISTS Graph(id STRING, name STRING, revision INT64, created_at STRING, updated_at STRING, PRIMARY KEY(id))",
            "CREATE NODE TABLE IF NOT EXISTS NodeType(id STRING, graph_id STRING, name STRING, PRIMARY KEY(id))",
            "CREATE NODE TABLE IF NOT EXISTS RelationshipType(id STRING, graph_id STRING, name STRING, from_type_id STRING, to_type_id STRING, PRIMARY KEY(id))",
            "CREATE NODE TABLE IF NOT EXISTS Entity(id STRING, graph_id STRING, type_id STRING, name STRING, description STRING, embedding FLOAT[384], embedding_hash STRING, PRIMARY KEY(id))",
            "CREATE REL TABLE IF NOT EXISTS Link(FROM Entity TO Entity, id STRING, graph_id STRING, type_id STRING)",
        ]:
            self.query(statement)

    def close(self):
        self.conn.close()
        self.db.close()

    def query(self, statement, params=None):
        result = self.conn.execute(statement, params or {})
        try:
            columns = result.get_column_names()
            rows = []
            while result.has_next():
                rows.append(dict(zip(columns, result.get_next())))
            return rows
        finally:
            result.close()

    @contextmanager
    def transaction(self):
        self.query("BEGIN TRANSACTION")
        try:
            yield
            self.query("COMMIT")
        except Exception:
            self.query("ROLLBACK")
            raise

    def metadata(self, graph_id):
        rows = self.query(
            "MATCH (g:Graph {id: $id}) RETURN g.id AS id, g.name AS name, g.revision AS revision, g.created_at AS created_at, g.updated_at AS updated_at",
            {"id": graph_id},
        )
        if not rows:
            raise HTTPException(404, "Graph not found.")
        return rows[0]

    def unique_name(self, name, graph_id=""):
        existing = self.query("MATCH (g:Graph) RETURN g.id AS id, g.name AS name")
        if any(row["id"] != graph_id and row["name"].casefold() == name.casefold() for row in existing):
            raise HTTPException(409, "A graph with this name already exists.")

    def list_graphs(self):
        with self.lock:
            return self.query(
                "MATCH (g:Graph) RETURN g.id AS id, g.name AS name, g.revision AS revision, g.updated_at AS updated_at ORDER BY g.name"
            )

    def create(self, name):
        with self.lock:
            self.unique_name(name)
            graph_id = str(uuid4())
            self.query(
                "CREATE (:Graph {id:$id, name:$name, revision:0, created_at:$time, updated_at:$time})",
                {"id": graph_id, "name": name, "time": now()},
            )
            return self.get(graph_id)

    def get(self, graph_id):
        with self.lock:
            result = self.metadata(graph_id)
            params = {"graph": graph_id}
            for key, table, fields in [
                ("node_types", "NodeType", ["id", "name"]),
                ("relationship_types", "RelationshipType", ["id", "name", "from_type_id", "to_type_id"]),
                ("nodes", "Entity", ["id", "name", "type_id", "description"]),
            ]:
                projection = ", ".join(f"n.{field} AS {field}" for field in fields)
                result[key] = self.query(f"MATCH (n:{table}) WHERE n.graph_id=$graph RETURN {projection} ORDER BY n.name", params)
            result["edges"] = self.query(
                "MATCH (a:Entity)-[e:Link]->(b:Entity) WHERE e.graph_id=$graph RETURN e.id AS id, e.type_id AS type_id, a.id AS source_id, b.id AS target_id ORDER BY e.id", params
            )
            return result

    def clear(self, graph_id):
        self.query("MATCH (n:Entity) WHERE n.graph_id=$graph DETACH DELETE n", {"graph": graph_id})
        for table in ("RelationshipType", "NodeType"):
            self.query(f"MATCH (n:{table}) WHERE n.graph_id=$graph DELETE n", {"graph": graph_id})

    def save(self, graph_id, payload: GraphSave):
        data = payload.model_dump(mode="json")
        with self.lock:
            old = self.get(graph_id)
            if old["revision"] != payload.revision:
                raise HTTPException(409, "This graph changed in another tab. Your draft is retained. Reload saved data before editing again.")
            self.unique_name(payload.name, graph_id)
            # Reject UUID reuse across graphs, including edge IDs (which are not primary keys).
            incoming = [item["id"] for key in ("node_types", "relationship_types", "nodes", "edges") for item in data[key]]
            if incoming:
                for table in ("NodeType", "RelationshipType", "Entity"):
                    rows = self.query(f"MATCH (n:{table}) WHERE n.graph_id <> $graph AND n.id IN $ids RETURN n.id AS id LIMIT 1", {"graph": graph_id, "ids": incoming})
                    if rows:
                        raise HTTPException(422, "A UUID in this draft belongs to another graph.")
                if self.query("MATCH ()-[e:Link]->() WHERE e.graph_id <> $graph AND e.id IN $ids RETURN e.id AS id LIMIT 1", {"graph": graph_id, "ids": incoming}):
                    raise HTTPException(422, "A relationship UUID belongs to another graph.")
            cache = {row["id"]: row for row in self.query(
                "MATCH (n:Entity) WHERE n.graph_id=$graph RETURN n.id AS id, n.embedding AS embedding, n.embedding_hash AS embedding_hash", {"graph": graph_id}
            )}
            old_nodes = {node["id"]: node for node in old["nodes"]}
            old_types = {item["id"]: item["name"] for item in old["node_types"]}
            new_types = {item["id"]: item["name"] for item in data["node_types"]}
            with self.transaction():
                self.clear(graph_id)
                for item in data["node_types"]:
                    self.query("CREATE (:NodeType {id:$id, graph_id:$graph, name:$name})", {**item, "graph": graph_id})
                for item in data["relationship_types"]:
                    self.query("CREATE (:RelationshipType {id:$id, graph_id:$graph, name:$name, from_type_id:$from_type_id, to_type_id:$to_type_id})", {**item, "graph": graph_id})
                for node in data["nodes"]:
                    previous = old_nodes.get(node["id"])
                    unchanged = previous == node and old_types.get(node["type_id"]) == new_types.get(node["type_id"])
                    cached = cache.get(node["id"], {}) if unchanged else {}
                    self.query(
                        "CREATE (:Entity {id:$id, graph_id:$graph, type_id:$type_id, name:$name, description:$description, embedding:$embedding, embedding_hash:$hash})",
                        {**node, "graph": graph_id, "embedding": cached.get("embedding"), "hash": cached.get("embedding_hash")},
                    )
                for edge in data["edges"]:
                    self.query(
                        "MATCH (a:Entity {id:$source_id}), (b:Entity {id:$target_id}) WHERE a.graph_id=$graph AND b.graph_id=$graph CREATE (a)-[:Link {id:$id, graph_id:$graph, type_id:$type_id}]->(b)",
                        {**edge, "graph": graph_id},
                    )
                self.query("MATCH (g:Graph {id:$id}) SET g.name=$name, g.revision=$revision, g.updated_at=$time", {"id": graph_id, "name": payload.name, "revision": payload.revision + 1, "time": now()})
            return self.get(graph_id)

    def delete(self, graph_id, revision):
        with self.lock:
            if self.metadata(graph_id)["revision"] != revision:
                raise HTTPException(409, "The graph changed. Reload saved data before deleting it.")
            with self.transaction():
                self.clear(graph_id)
                self.query("MATCH (g:Graph {id:$id}) DELETE g", {"id": graph_id})
