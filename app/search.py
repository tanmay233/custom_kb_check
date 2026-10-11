import hashlib
import logging

from fastapi import HTTPException

from .models import SearchRequest


logger = logging.getLogger(__name__)


def search_graph(store, embeddings, graph_id: str, request: SearchRequest):
    with store.lock:
        graph = store.get(graph_id)
        hashes = {row["id"]: row["hash"] for row in store.query(
            "MATCH (n:Entity) WHERE n.graph_id=$graph RETURN n.id AS id, n.embedding_hash AS hash", {"graph": graph_id}
        )}
    types = {item["id"]: item["name"] for item in graph["node_types"]}
    type_id = str(request.node_type_id) if request.node_type_id else ""
    if type_id and type_id not in types:
        raise HTTPException(422, "The node type does not belong to this graph.")
    candidates = [node for node in graph["nodes"] if not type_id or node["type_id"] == type_id]
    scores, query_vector, indexed = {}, None, 0
    if candidates and request.mode != "keyword":
        pending = []
        for node in candidates:
            text = f"{node['name']}\nType: {types[node['type_id']]}\n{node['description']}"
            fingerprint = hashlib.sha256(f"{embeddings.model_name}\n{text}".encode()).hexdigest()
            if hashes.get(node["id"]) != fingerprint:
                pending.append((node["id"], text, fingerprint))
        try:
            vectors = embeddings.documents([item[1] for item in pending]) if pending else []
            query_vector = embeddings.query(request.query)
        except Exception as exc:
            logger.exception("Local embedding model could not run")
            raise HTTPException(503, "The local embedding model could not load or run. On first use, allow internet access to download the model, then retry. Keyword search is available without it.") from exc
        with store.lock:
            if store.metadata(graph_id)["revision"] != graph["revision"]:
                raise HTTPException(409, "The graph was saved while search was preparing. Please search again.")
            with store.transaction():
                for (node_id, _, fingerprint), vector in zip(pending, vectors, strict=True):
                    store.query("MATCH (n:Entity {id:$id}) WHERE n.graph_id=$graph SET n.embedding=$vector, n.embedding_hash=$hash", {"id": node_id, "graph": graph_id, "vector": vector, "hash": fingerprint})
            indexed = len(pending)
    with store.lock:
        if store.metadata(graph_id)["revision"] != graph["revision"]:
            raise HTTPException(409, "The graph changed during search. Please search again.")
        params = {"graph": graph_id, "type": type_id}
        vector_rows, keyword_rows = [], []
        if query_vector is not None:
            vector_rows = store.query(
                "MATCH (n:Entity) WHERE n.graph_id=$graph AND ($type='' OR n.type_id=$type) AND n.embedding IS NOT NULL "
                "RETURN n.id AS id, array_cosine_similarity(n.embedding, CAST($vector AS FLOAT[384])) AS score ORDER BY score DESC, n.id",
                {**params, "vector": query_vector},
            )
        if request.mode != "semantic":
            keyword_rows = store.query(
                "MATCH (n:Entity), (t:NodeType) WHERE n.graph_id=$graph AND t.graph_id=$graph AND n.type_id=t.id AND ($type='' OR n.type_id=$type) "
                "AND (lower(n.name) CONTAINS $q OR lower(n.description) CONTAINS $q OR lower(t.name) CONTAINS $q OR lower(n.id) CONTAINS $q) "
                "RETURN n.id AS id, CASE WHEN lower(n.id)=$q OR lower(n.name)=$q THEN 3.0 WHEN lower(n.name) CONTAINS $q THEN 2.0 ELSE 1.0 END AS score ORDER BY score DESC, n.id",
                {**params, "q": request.query.lower()},
            )
    if request.mode == "hybrid":
        # Reciprocal-rank fusion avoids mixing incomparable cosine and text scores.
        for rows in (vector_rows, keyword_rows):
            for rank, row in enumerate(rows, 1):
                scores[row["id"]] = scores.get(row["id"], 0) + 1 / (60 + rank)
    else:
        scores = {row["id"]: row["score"] for row in (vector_rows if request.mode == "semantic" else keyword_rows)}
    nodes = {node["id"]: node for node in graph["nodes"]}
    relationship_types = {item["id"]: item["name"] for item in graph["relationship_types"]}
    hits = []
    for node_id, score in sorted(scores.items(), key=lambda item: (-item[1], item[0]))[:request.limit]:
        connections = []
        for edge in graph["edges"]:
            if node_id in (edge["source_id"], edge["target_id"]):
                connections.append({**edge, "relationship": relationship_types[edge["type_id"]], "source_name": nodes[edge["source_id"]]["name"], "target_name": nodes[edge["target_id"]]["name"]})
        hits.append({**nodes[node_id], "type_name": types[nodes[node_id]["type_id"]], "score": score, "connections": connections})
    return {"results": hits, "mode": request.mode, "revision": graph["revision"], "indexed_nodes": indexed, "model": embeddings.model_name if request.mode != "keyword" else None}
