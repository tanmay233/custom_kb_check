"""Opt-in integration check with the actual local model and Kuzu vector search."""
import os

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from test_api import draft, saved_graph


@pytest.mark.skipif(os.getenv("RUN_MODEL_TESTS") != "1", reason="Set RUN_MODEL_TESTS=1 to use/download the real model")
def test_real_model_vector_and_name_search(tmp_path):
    with TestClient(create_app(tmp_path / "model-db")) as client:
        graph_id, data = saved_graph(client, draft("Real vector search"))
        url = f"/api/graphs/{graph_id}/search"
        request = {"query": "Alice", "mode": "vector", "node_type_id": data["node_types"][0]["id"]}
        response = client.post(url, json=request)
        assert response.status_code == 200, response.text
        results = response.json()["results"]
        assert results[0]["name"] == "Alice"
        assert results[0]["score"] > results[1]["score"]
        assert response.json()["indexed_nodes"] == 2
        request["mode"] = "semantic"
        response = client.post(url, json=request)
        assert response.status_code == 200, response.text
        assert response.json()["results"][0]["name"] == "Alice"
        assert response.json()["indexed_nodes"] == 0
        assert response.json()["model"] is None
