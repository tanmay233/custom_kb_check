from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


def uid():
    return str(uuid4())


class TestEmbeddings:
    """Deterministic vectors isolate Kuzu ranking/persistence from model downloads."""

    __test__ = False
    model_name = "test-384"
    loaded = True

    def __init__(self):
        self.document_calls = 0

    def vector(self, text):
        axis = 0 if any(word in text.lower() for word in ("energy", "solar", "climate")) else 1
        return [1.0 if i == axis else 0.0 for i in range(384)]

    def documents(self, texts):
        self.document_calls += len(texts)
        return [self.vector(text) for text in texts]

    def query(self, text):
        return self.vector(text)


@pytest.fixture
def environment(tmp_path):
    embeddings = TestEmbeddings()
    application = create_app(tmp_path / "db", embeddings)
    with TestClient(application) as client:
        yield client, embeddings, application


def draft(name="Research"):
    person, company, works, alice, acme, book = [uid() for _ in range(6)]
    return {
        "name": name, "revision": 0,
        "node_types": [{"id": person, "name": "Person"}, {"id": company, "name": "Company"}],
        "relationship_types": [{"id": works, "name": "WORKS_AT", "from_type_id": person, "to_type_id": company}],
        "nodes": [
            {"id": alice, "type_id": person, "name": "Alice", "description": "Solar energy researcher"},
            {"id": acme, "type_id": company, "name": "Acme", "description": "Clean energy and climate technology"},
            {"id": book, "type_id": person, "name": "Bob", "description": "Writes history books"},
        ],
        "edges": [{"id": uid(), "type_id": works, "source_id": alice, "target_id": acme}],
    }


def saved_graph(client, data=None):
    data = data or draft()
    created = client.post("/api/graphs", json={"name": data["name"]})
    assert created.status_code == 201, created.text
    graph_id = created.json()["id"]
    response = client.put(f"/api/graphs/{graph_id}", json=data)
    assert response.status_code == 200, response.text
    data["revision"] = response.json()["revision"]
    return graph_id, data


def test_crud_persistence_restart_and_graph_isolation(tmp_path):
    path = tmp_path / "persistent"
    with TestClient(create_app(path, TestEmbeddings())) as client:
        graph_id, data = saved_graph(client)
        other_id, other = saved_graph(client, draft("Other"))
        data["nodes"][0]["name"] = "Alice O'Connor <script>"
        data["nodes"][0]["description"] = "Updated research"
        data["edges"][0]["source_id"] = data["nodes"][2]["id"]
        updated = client.put(f"/api/graphs/{graph_id}", json=data)
        assert updated.status_code == 200, updated.text
        data["revision"] += 1
    # Open a fresh application and Kuzu connection to verify durable storage.
    with TestClient(create_app(path, TestEmbeddings())) as client:
        current = client.get(f"/api/graphs/{graph_id}").json()
        assert next(node for node in current["nodes"] if node["id"] == data["nodes"][0]["id"])["name"] == "Alice O'Connor <script>"
        assert current["edges"][0]["source_id"] == data["nodes"][2]["id"]
        assert client.get(f"/api/graphs/{other_id}").json()["revision"] == 1
        data["nodes"].pop(2)
        data["edges"] = []
        assert client.put(f"/api/graphs/{graph_id}", json=data).status_code == 200
        assert client.delete(f"/api/graphs/{graph_id}?revision=3").status_code == 204
        assert client.get(f"/api/graphs/{graph_id}").status_code == 404
        assert len(client.get(f"/api/graphs/{other_id}").json()["edges"]) == 1


def test_conflicts_invalid_endpoints_and_duplicate_mappings(environment):
    client, _, _ = environment
    graph_id, data = saved_graph(client)
    stale = deepcopy(data)
    stale["revision"] = 0
    assert client.put(f"/api/graphs/{graph_id}", json=stale).status_code == 409
    assert client.delete(f"/api/graphs/{graph_id}?revision=0").status_code == 409
    assert client.post("/api/graphs", json={"name": "research"}).status_code == 409
    broken = deepcopy(data)
    broken["edges"][0]["source_id"] = data["nodes"][1]["id"]
    assert client.put(f"/api/graphs/{graph_id}", json=broken).status_code == 422
    broken = deepcopy(data)
    broken["nodes"].pop(0)
    assert client.put(f"/api/graphs/{graph_id}", json=broken).status_code == 422
    broken = deepcopy(data)
    broken["edges"].append({**broken["edges"][0], "id": uid()})
    assert client.put(f"/api/graphs/{graph_id}", json=broken).status_code == 422
    other_id = client.post("/api/graphs", json={"name": "Second"}).json()["id"]
    broken = deepcopy(data)
    broken.update(name="Second", revision=0)
    assert client.put(f"/api/graphs/{other_id}", json=broken).status_code == 422
    assert client.get(f"/api/graphs/{graph_id}").json()["revision"] == 1


def test_transaction_failure_rolls_back(environment, monkeypatch):
    client, _, application = environment
    graph_id, data = saved_graph(client)
    before = client.get(f"/api/graphs/{graph_id}").json()
    original = application.state.store.query

    def fail_on_insert(statement, params=None):
        if statement.startswith("CREATE (:Entity"):
            raise RuntimeError("Simulated write failure")
        return original(statement, params)

    monkeypatch.setattr(application.state.store, "query", fail_on_insert)
    data["name"] = "Must not persist"
    assert client.put(f"/api/graphs/{graph_id}", json=data).status_code == 500
    assert client.get(f"/api/graphs/{graph_id}").json() == before


def test_keyword_uuid_semantic_hybrid_filter_and_index_invalidation(environment):
    client, embeddings, _ = environment
    graph_id, data = saved_graph(client)
    other_id, other = saved_graph(client, draft("Other"))
    url = f"/api/graphs/{graph_id}/search"
    response = client.post(url, json={"query": data["nodes"][0]["id"], "mode": "keyword"})
    assert response.status_code == 200, response.text
    assert response.json()["results"][0]["name"] == "Alice"
    assert response.json()["results"][0]["connections"][0]["relationship"] == "WORKS_AT"
    assert embeddings.document_calls == 0
    response = client.post(url, json={"query": "energy", "mode": "semantic", "node_type_id": data["node_types"][0]["id"]})
    assert response.status_code == 200, response.text
    results = response.json()["results"]
    assert [node["name"] for node in results] == ["Alice", "Bob"]
    assert results[0]["score"] > .99
    assert embeddings.document_calls == 2
    assert not set(node["id"] for node in results).intersection(node["id"] for node in other["nodes"])
    repeat = client.post(url, json={"query": "energy", "mode": "hybrid", "node_type_id": data["node_types"][0]["id"]})
    assert repeat.status_code == 200, repeat.text
    assert repeat.json()["results"][0]["name"] == "Alice"
    assert embeddings.document_calls == 2
    # Saving an unchanged graph preserves cached embeddings.
    response = client.put(f"/api/graphs/{graph_id}", json=data)
    assert response.status_code == 200, response.text
    data["revision"] += 1
    client.post(url, json={"query": "energy", "mode": "semantic", "node_type_id": data["node_types"][0]["id"]})
    assert embeddings.document_calls == 2
    data["nodes"][0]["description"] = "Writes novels"
    assert client.put(f"/api/graphs/{graph_id}", json=data).status_code == 200
    client.post(url, json={"query": "energy", "mode": "semantic", "node_type_id": data["node_types"][0]["id"]})
    assert embeddings.document_calls == 3
    assert client.post(url, json={"query": "energy", "node_type_id": other["node_types"][0]["id"]}).status_code == 422


def test_empty_graph_and_model_failure_do_not_break_keyword_search(environment, monkeypatch):
    client, embeddings, _ = environment
    empty = client.post("/api/graphs", json={"name": "Empty"}).json()["id"]
    assert client.post(f"/api/graphs/{empty}/search", json={"query": "anything"}).json()["results"] == []
    graph_id, data = saved_graph(client)

    def unavailable(texts):
        raise ConnectionError("Offline")

    monkeypatch.setattr(embeddings, "documents", unavailable)
    url = f"/api/graphs/{graph_id}/search"
    assert client.post(url, json={"query": "energy", "mode": "semantic"}).status_code == 503
    assert client.post(url, json={"query": "Alice", "mode": "keyword"}).json()["results"][0]["name"] == "Alice"
    assert client.get(f"/api/graphs/{graph_id}").json()["revision"] == 1


def test_duplicate_node_names_and_self_relationship(environment):
    client, _, _ = environment
    data = draft()
    data["nodes"][2]["name"] = data["nodes"][0]["name"]
    relation = {"id": uid(), "name": "KNOWS", "from_type_id": data["node_types"][0]["id"], "to_type_id": data["node_types"][0]["id"]}
    data["relationship_types"].append(relation)
    data["edges"].append({"id": uid(), "type_id": relation["id"], "source_id": data["nodes"][0]["id"], "target_id": data["nodes"][0]["id"]})
    graph_id, data = saved_graph(client, data)
    results = client.post(f"/api/graphs/{graph_id}/search", json={"query": "Alice", "mode": "keyword"}).json()["results"]
    assert len(results) == 2
    assert len({node["id"] for node in results}) == 2
