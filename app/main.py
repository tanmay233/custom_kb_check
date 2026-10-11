import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import UUID

from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .embeddings import EmbeddingService
from .models import GraphCreate, GraphSave, SearchRequest
from .search import search_graph
from .store import GraphStore


ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def configured_path(name, fallback):
    path = Path(os.getenv(name, fallback))
    return path if path.is_absolute() else ROOT / path


def create_app(data_dir: Path | None = None, embeddings=None):
    @asynccontextmanager
    async def lifespan(app):
        app.state.store = GraphStore(data_dir or configured_path("KG_DATA_DIR", "data"), int(os.getenv("KG_DB_MEMORY_MB", "512")))
        app.state.embeddings = embeddings or EmbeddingService(
            os.getenv("KG_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"), configured_path("KG_MODEL_CACHE", "data/models")
        )
        yield
        app.state.store.close()

    app = FastAPI(title="Graph Studio", lifespan=lifespan)

    @app.exception_handler(RuntimeError)
    async def database_error(request: Request, exc: RuntimeError):
        logging.getLogger(__name__).exception("Database operation failed", exc_info=exc)
        return JSONResponse(status_code=500, content={"detail": "The database operation failed. Your draft is retained; check the server log and retry."})

    @app.get("/api/health")
    def health(request: Request):
        service = request.app.state.embeddings
        return {"status": "ok", "database": "Kuzu", "model": service.model_name, "model_loaded": service.loaded}

    @app.get("/api/graphs")
    def list_graphs(request: Request):
        return request.app.state.store.list_graphs()

    @app.post("/api/graphs", status_code=201)
    def create_graph(body: GraphCreate, request: Request):
        return request.app.state.store.create(body.name)

    @app.get("/api/graphs/{graph_id}")
    def get_graph(graph_id: UUID, request: Request):
        return request.app.state.store.get(str(graph_id))

    @app.put("/api/graphs/{graph_id}")
    def save_graph(graph_id: UUID, body: GraphSave, request: Request):
        return request.app.state.store.save(str(graph_id), body)

    @app.delete("/api/graphs/{graph_id}", status_code=204)
    def delete_graph(graph_id: UUID, request: Request, revision: int = Query(ge=0)):
        request.app.state.store.delete(str(graph_id), revision)

    @app.post("/api/graphs/{graph_id}/search")
    def search(graph_id: UUID, body: SearchRequest, request: Request):
        return search_graph(request.app.state.store, request.app.state.embeddings, str(graph_id), body)

    app.mount("/static", StaticFiles(directory=ROOT / "app" / "static"), name="static")

    @app.get("/")
    def index():
        return FileResponse(ROOT / "app" / "static" / "index.html")

    return app


app = create_app()
