"""Search contracts, graph isolation, and failure paths against real Kuzu."""
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models import GraphSave
from test_api import TestEmbeddings, draft, environment, saved_graph, uid


def search(client, graph_id, query, mode="semantic", **options):
    return client.post(f"/api/graphs/{graph_id}/search", json={"query": query, "mode": mode, **options})


def test_lexical_scores_name_only_unicode_and_partial_matches(environment):
    client, embeddings, _ = environment
    data = draft()
    data["edges"] = []
    names = ["Solar Research", "Solar", "Solar Research Institute", "SOLAR_research", "History", "ＳＯＬＡＲ research"]
    data["nodes"] = [{"id": uid(), "type_id": data["node_types"][0]["id"], "name": name, "description": "Solar Research"} for name in names]
    graph_id, data = saved_graph(client, data)
    response = search(client, graph_id, "  SOLAR research! ")
    assert response.status_code == 200, response.text
    body = response.json()
    results = body["results"]
    assert len(results) == 5
    scores = {node["name"]: node["score"] for node in results}
    assert scores["Solar Research"] == scores["SOLAR_research"] == scores["ＳＯＬＡＲ research"] == 1
    assert scores["Solar Research Institute"] == pytest.approx(.8)
    assert scores["Solar"] == pytest.approx(2 / 3)
    assert "History" not in scores  # Description is not searched.
    assert [node["id"] for node in results[:3]] == sorted(node["id"] for node in results[:3])
    partial = search(client, graph_id, "resear").json()["results"]
    assert partial and all(0 < node["score"] < 1 for node in partial)
    for query in ("zzzmissing", "!!!", data["nodes"][0]["id"], "Person"):
        assert search(client, graph_id, query).json()["results"] == []
    assert body["model"] is None and body["indexed_nodes"] == 0
    assert embeddings.document_calls == 0


@pytest.mark.parametrize("mode", ["vector", "semantic"])
def test_default_five_configurable_limit_and_graph_isolation(environment, mode):
    client, _, _ = environment
    data = draft()
    data["edges"] = []
    data["nodes"] = [{"id": uid(), "type_id": data["node_types"][0]["id"], "name": f"Solar {i}", "description": "Visible context"} for i in range(8)]
    graph_id, data = saved_graph(client, data)
    other_id, other = saved_graph(client, draft("Other"))
    own_ids = {node["id"] for node in data["nodes"]}
    for limit, count in ((None, 5), (1, 1), (100, 8)):
        response = search(client, graph_id, "solar", mode, **({"limit": limit} if limit else {}))
        assert response.status_code == 200, response.text
        results = response.json()["results"]
        assert len(results) == count
        assert all(node["id"] in own_ids and node["description"] == "Visible context" for node in results)
        assert all(isinstance(node["score"], float) for node in results)
    assert search(client, graph_id, "solar", mode, node_type_id=other["node_types"][0]["id"]).status_code == 422
    assert search(client, graph_id, "solar", mode, node_type_id=data["node_types"][1]["id"]).json()["results"] == []


def test_vector_cache_survives_restart_and_refreshes_legacy_and_model_changes(tmp_path):
    path = tmp_path / "cache-db"
    first = TestEmbeddings()
    with TestClient(create_app(path, first)) as client:
        graph_id, data = saved_graph(client)
        response = search(client, graph_id, "energy", "vector")
        assert response.status_code == 200, response.text
        # Names Alice/Acme/Bob do not mention energy despite their descriptions.
        assert all(node["score"] == 0 for node in response.json()["results"])
        assert set(first.document_texts) == {"Alice", "Acme", "Bob"}
    second = TestEmbeddings()
    app = create_app(path, second)
    with TestClient(app) as client:
        assert search(client, graph_id, "energy", "vector").json()["indexed_nodes"] == 0
        assert second.document_calls == 0
        app.state.store.query("MATCH (n:Entity {id:$id}) SET n.embedding_hash='legacy-context-hash'", {"id": data["nodes"][0]["id"]})
        assert search(client, graph_id, "energy", "vector").json()["indexed_nodes"] == 1
        second.model_name = "changed-test-model-384"
        assert search(client, graph_id, "energy", "vector").json()["indexed_nodes"] == 3


def test_cypher_returns_scoped_rows_and_node_descriptions(environment):
    client, _, _ = environment
    graph_id, data = saved_graph(client)
    other_id, other = saved_graph(client, draft("Other"))

    nodes = search(client, graph_id, "MATCH (n:Entity) RETURN n.id AS uuid, n.name AS name", "cypher")
    assert nodes.status_code == 200, nodes.text
    body = nodes.json()
    assert body["columns"] == ["uuid", "name", "n.description"]
    assert {row[0] for row in body["rows"]} == {node["id"] for node in data["nodes"]}
    assert {row[2] for row in body["rows"]} == {node["description"] for node in data["nodes"]}
    assert not {row[0] for row in body["rows"]}.intersection(node["id"] for node in other["nodes"])
    assert body["row_limit"] == 100 and body["truncated"] is False

    relation = search(
        client,
        graph_id,
        "MATCH (a:Entity)-[r:Link]->(b:Entity) WHERE r.name = 'WORKS_AT' "
        "RETURN a.id AS source_id, a.name AS source, r.name AS relationship, b.id AS target_id, b.name AS target",
        "cypher",
    )
    assert relation.status_code == 200, relation.text
    relation_body = relation.json()
    assert relation_body["columns"] == ["source_id", "source", "relationship", "target_id", "target", "a.description", "b.description"]
    assert relation_body["rows"] == [[
        data["nodes"][0]["id"], "Alice", "WORKS_AT", data["nodes"][1]["id"], "Acme",
        "Solar energy researcher", "Clean energy and climate technology",
    ]]

    by_id = search(client, graph_id, f"MATCH (n:Entity {{uuid: '{data['nodes'][0]['id']}'}}) RETURN n", "cypher")
    assert by_id.status_code == 200, by_id.text
    assert by_id.json()["rows"][0][0]["description"] == data["nodes"][0]["description"]


def test_cypher_query_limit_and_error_handling(environment):
    client, _, _ = environment
    data = draft()
    data["edges"] = []
    data["nodes"] = [{"id": uid(), "type_id": data["node_types"][0]["id"], "name": f"Node {index}", "description": "context"} for index in range(101)]
    graph_id, _ = saved_graph(client, data)

    limited = search(client, graph_id, "MATCH (n:Entity) RETURN n.id", "cypher")
    assert limited.status_code == 200, limited.text
    assert len(limited.json()["rows"]) == 100
    assert limited.json()["truncated"] is True
    explicit = search(client, graph_id, "MATCH (n:Entity) RETURN n.id LIMIT 3", "cypher")
    assert len(explicit.json()["rows"]) == 3
    assert explicit.json()["truncated"] is False

    failures = [
        ("CREATE (n:Entity {name: 'bad'}) RETURN n", 403, "read-only"),
        ("MATCH (n:Entity) WHERE n.description CONTAINS 'context' RETURN n.name", 422, "node names"),
        ("MATCH (n:Graph) RETURN n.name", 422, "Unsupported label"),
        ("MATCH (n:Entity) RETURN n.", 400, "Expected an identifier"),
        ("MATCH (n:Entity) RETURN n.name; MATCH (m:Entity) RETURN m.name", 400, "Only one"),
    ]
    for query, status, message in failures:
        response = search(client, graph_id, query, "cypher")
        assert response.status_code == status, (query, response.text)
        assert message.lower() in response.json()["detail"].lower()
    assert search(client, graph_id, "MATCH (n:Entity) RETURN n.name", "cypher", node_type_id=data["node_types"][0]["id"]).status_code == 422


@pytest.mark.parametrize("options", [
    {"query": ""}, {"query": "   "}, {"query": "x" * 2001},
    {"mode": "unknown"}, {"limit": 0}, {"limit": 101}, {"limit": 1.5},
    {"limit": True}, {"node_type_id": "bad-uuid"}, {"unexpected": "field"},
])
def test_search_input_validation(environment, options):
    client, _, _ = environment
    graph_id, _ = saved_graph(client)
    body = {"query": "Alice", "mode": "semantic", **options}
    response = client.post(f"/api/graphs/{graph_id}/search", json=body)
    assert response.status_code == 422, response.text
    assert response.json()["detail"]


@pytest.mark.parametrize("mode", ["semantic", "vector", "cypher"])
def test_missing_and_empty_graphs(environment, mode):
    client, embeddings, _ = environment
    query = "MATCH (n) RETURN n.id, n.name" if mode == "cypher" else "Alice"
    assert search(client, uid(), query, mode).status_code == 404
    assert search(client, "bad-uuid", query, mode).status_code == 422
    graph_id = client.post("/api/graphs", json={"name": "Empty"}).json()["id"]
    response = search(client, graph_id, query, mode)
    assert response.status_code == 200, response.text
    assert response.json()["rows" if mode == "cypher" else "results"] == []
    assert embeddings.document_calls == 0


def test_cypher_read_only_adversarial_queries_and_recovery(environment):
    client, _, _ = environment
    graph_id, data = saved_graph(client)
    other_id, other = saved_graph(client, draft("Other"))
    before = client.get(f"/api/graphs/{graph_id}").json()
    other_before = client.get(f"/api/graphs/{other_id}").json()
    forbidden = [
        "MATCH (n) SET n.name='changed' RETURN n",
        "MATCH (n) DETACH DELETE n",
        "MATCH (n) REMOVE n.name RETURN n",
        "MERGE (n:Entity {name:'test'}) RETURN n",
        "DROP TABLE Entity",
        "CALL show_tables() RETURN *",
        "LOAD EXTENSION httpfs",
        "MATCH (n) RETURN n; CREATE (:Entity)",
    ]
    for query in forbidden:
        response = search(client, graph_id, query, "cypher")
        assert response.status_code == 403, (query, response.text)
    unsupported = [
        "MATCH (n) RETURN n.embedding", "MATCH (n) RETURN n.graph_id",
        "MATCH (n {description:'Solar'}) RETURN n", "MATCH (n) WHERE lower(n.description)='solar' RETURN n",
        "MATCH (n) WHERE n.type_id='x' RETURN n", "MATCH (a)-[r]->(b) WHERE r.id='x' RETURN r",
        "MATCH (g:Graph) RETURN g", "MATCH (t:NodeType) RETURN t",
        "MATCH (n) RETURN count(n)", "MATCH (n) RETURN n.name AS x, n.id AS x",
    ]
    for query in unsupported:
        assert search(client, graph_id, query, "cypher").status_code == 422, query
    malformed = [
        "MATCH (n) RETURN", "MATCH (n) RETURN n ORDER BY", "MATCH (n) WHERE n.name =",
        "MATCH (n) RETURN n LIMIT -1", "MATCH (n) RETURN n LIMIT 1.5",
        "MATCH (n) RETURN n // comment", "MATCH (n) RETURN n UNION MATCH (x) RETURN x",
        "MATCH (n) WHERE n.name=$graph RETURN n", "MATCH (n) RETURN " + "9" * 500,
        "MATCH (n) WHERE " + "(" * 20 + "n.name='Alice'" + ")" * 20 + " RETURN n",
    ]
    for query in malformed:
        assert search(client, graph_id, query, "cypher").status_code == 400, query
    # OR cannot weaken the independently compiled scope predicates.
    response = search(client, graph_id, "MATCH (n) WHERE n.name='missing' OR 1=1 RETURN n.id", "cypher")
    assert response.status_code == 200, response.text
    assert {row[0] for row in response.json()["rows"]} == {node["id"] for node in data["nodes"]}
    assert search(client, graph_id, f"MATCH (n) WHERE n.id='{other['nodes'][0]['id']}' RETURN n", "cypher").json()["rows"] == []
    assert client.get(f"/api/graphs/{graph_id}").json() == before
    assert client.get(f"/api/graphs/{other_id}").json() == other_before


@pytest.mark.parametrize("failure", ["wrong_count", "wrong_dimension", "nan", "zero", "query_failure"])
def test_invalid_embeddings_are_clear_503_without_partial_cache(environment, monkeypatch, failure):
    client, embeddings, app = environment
    graph_id, data = saved_graph(client)
    if failure == "query_failure":
        def fail_query(text):
            raise ConnectionError("Unavailable")
        monkeypatch.setattr(embeddings, "query", fail_query)
    else:
        vectors = {"wrong_count": [], "wrong_dimension": [[1.0]], "nan": [[float("nan")] * 384], "zero": [[0.0] * 384]}[failure]
        monkeypatch.setattr(embeddings, "documents", lambda texts: vectors)
    response = search(client, graph_id, "solar", "vector")
    assert response.status_code == 503
    assert "local embedding model" in response.json()["detail"]
    assert app.state.store.query("MATCH (n:Entity) WHERE n.embedding IS NOT NULL RETURN n.id AS id") == []
    assert search(client, graph_id, "Alice").status_code == 200
    assert client.get(f"/api/graphs/{graph_id}").json()["revision"] == data["revision"]


@pytest.mark.parametrize("deleted", [False, True])
def test_search_rejects_graph_changes_during_embedding(environment, monkeypatch, deleted):
    client, embeddings, app = environment
    graph_id, data = saved_graph(client)
    original = embeddings.documents

    def changed_while_preparing(texts):
        if deleted:
            app.state.store.delete(graph_id, data["revision"])
        else:
            updated = deepcopy(data)
            updated["nodes"][0]["name"] = "Changed name"
            app.state.store.save(graph_id, GraphSave(**updated))
        return original(texts)

    monkeypatch.setattr(embeddings, "documents", changed_while_preparing)
    response = search(client, graph_id, "solar", "vector")
    assert response.status_code == 409
    assert "during search" in response.json()["detail"]
