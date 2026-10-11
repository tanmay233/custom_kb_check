# Graph Studio — Handoff

Read this first when taking over the project. It is a local FastAPI + Kùzu knowledge-graph editor and search app. Users create graphs, node types, relationship definitions, nodes, and edges in a browser; saved data is persisted in Kùzu. Keyword search is offline; semantic/hybrid search uses a cached local 384-dimensional BGE model.

## Run

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`. See `README.md` for full setup/troubleshooting.

## Structure

```text
app/
  main.py          FastAPI app, routes, startup/configuration
  models.py        Pydantic request/data validation
  store.py         Kùzu database and graph persistence
  search.py        Keyword, vector, and hybrid search
  embeddings.py    Lazy local FastEmbed model wrapper
  static/
    index.html     UI markup
    app.js         UI state, forms, API calls, draft handling
    graph.js       SVG graph canvas and interactions
    styles.css     UI styles
scripts/warm_model.py  Download/validate embedding model
tests/             API, browser, and real-model tests
data/              Kùzu database, logs, and model cache
requirements*.txt  Runtime/development dependencies
.env.example       Configuration defaults
README.md          User setup and usage guide
STARTED.md         This handoff reference
```

## Data flow and API

Browser draft → `app.js` → FastAPI routes in `main.py` → `GraphStore`/Kùzu. Search reads saved graph data; semantic search asks `EmbeddingService` for vectors, caches them in Kùzu, then `search.py` ranks results. All IDs are UUID strings. `GraphSave.revision` prevents stale-tab overwrites.

Routes in `app/main.py`:

- `GET /` — serve UI; `GET /static/*` — static assets.
- `GET /api/health` — service/model status.
- `GET /api/graphs` — list graphs.
- `POST /api/graphs` — create empty graph; input `{name}`.
- `GET /api/graphs/{id}` — return graph metadata, types, nodes, and edges.
- `PUT /api/graphs/{id}` — validate and atomically save `GraphSave`; output saved graph/revision.
- `DELETE /api/graphs/{id}?revision=N` — delete graph if revision matches.
- `POST /api/graphs/{id}/search` — input `SearchRequest`; output ranked nodes and connections.

## Python files: methods and purpose

### `app/main.py`

- `configured_path(name, fallback)` — resolve env-configured paths relative to project root.
- `create_app(data_dir=None, embeddings=None)` — build/configure FastAPI; optional args enable isolated tests.
- Lifespan setup — creates `GraphStore` and `EmbeddingService`; closes Kùzu on shutdown.
- Route handlers — thin HTTP adapters around store/search operations listed above.

### `app/models.py`

Pydantic models are input/output contracts: `GraphCreate(name)`, `NodeType(id,name)`, `RelationshipType(...,from_type_id,to_type_id)`, `Node(...,type_id,description)`, `Edge(id,type_id,source_id,target_id)`, `GraphSave(...)`, and `SearchRequest(query,mode,limit,node_type_id)`.

- `GraphSave.valid_graph()` — rejects duplicate IDs/names, missing references, invalid endpoint types, and duplicate mappings; returns the validated model.
- `StrictModel` — forbids unknown fields. `Name` and search fields enforce length/whitespace limits.

### `app/store.py` — `GraphStore`

- `__init__(directory, memory_mb=512)` — open/create `data/knowledge.kuzu`, create schema, and fail clearly on database locks.
- `close()` — close Kùzu connection/database.
- `query(statement, params=None)` — execute parameterized Kùzu query; return list of dictionaries.
- `transaction()` — context manager for BEGIN/COMMIT; rolls back on error.
- `metadata(graph_id)` — return graph metadata or 404.
- `unique_name(name, graph_id='')` — enforce case-insensitive graph-name uniqueness.
- `list_graphs()` — return graph summaries sorted by name.
- `create(name)` — create UUID graph at revision 0; return complete graph.
- `get(graph_id)` — assemble graph metadata, node types, relationship types, nodes, and edges.
- `clear(graph_id)` — remove graph-owned entities/types before replacement save.
- `save(graph_id, payload)` — check revision/UUID ownership, preserve valid embedding cache, atomically replace graph contents, increment revision, and return saved graph.
- `delete(graph_id, revision)` — revision-check and permanently delete a graph.
- `now()` — return current UTC ISO timestamp.

### `app/embeddings.py` — `EmbeddingService`

- `__init__(model_name, cache_dir)` — configure lazy model/cache; no download yet.
- `_load()` — instantiate FastEmbed model on first use.
- `_vectors(vectors)` — convert vectors to lists and require 384 dimensions.
- `documents(texts)` — embed node documents; output `list[list[float]]`.
- `query(text)` — embed one query; output `list[float]`.
- `loaded` — property indicating whether the model is loaded.

### `app/search.py`

- `search_graph(store, embeddings, graph_id, request)` — filter candidate nodes, optionally refresh missing/stale embeddings, run keyword/vector queries, combine hybrid results with reciprocal-rank fusion, and return results with scores/connections. Raises 422 for an invalid graph type and 503 if the local model cannot run.

### `scripts/warm_model.py`

- Main script creates `EmbeddingService`, embeds one document and query, and prints dimensions. Run with `python scripts/warm_model.py` to download/check the configured model.

## Browser JavaScript

### `app/static/graph.js` — `GraphCanvas`

- `constructor(svg,onSelect)` — attach pointer/wheel/keyboard handlers and resize fitting.
- `localPoint(event)` — convert browser coordinates to SVG-local coordinates.
- `setGraph(graph)` — load graph and initialize node positions.
- `layout()` — reset node positions.
- `fit()` — fit all nodes to viewport.
- `zoom(factor,point)` — zoom around a point.
- `transform()` — apply viewport transform.
- `select(kind,id)` — select node/edge and notify app.
- `highlight(query)` — dim nonmatching nodes/edges.
- `pointerDown/Move/Up()` — drag nodes, pan canvas, and select items.
- `render()` — draw SVG nodes, directed edges, labels, selection, and filtering.

### `app/static/app.js`

Core helpers: `api()` calls backend and normalizes errors; `busy()` serializes UI operations; `payload()` prepares saves; `readDraft/removeDraft/changed()` manage browser local-storage drafts; `resolveNode()` resolves name/UUID input; `nodeTypeName/relType/nodeById()` look up graph data.

Rendering: `renderSidebar()`, `renderStatus()`, `renderMapping()`, `render()`, and `renderInspector()` update the UI; `refreshGraphs()` and `openGraph()` load server/draft state; `switchTab()` changes creation/search tabs.

Editing: `uniqueName()` validates names; form handlers create/update node types, relationship types, nodes, and edges; `resetRelTypeForm()`, `cancelMapping()`, `loadNode()`, and `loadEdge()` control editors. Save/reload/delete handlers persist or discard drafts. Search submits keyword/semantic/hybrid requests and renders ranked results.

### `app/static/index.html` and `styles.css`

`index.html` defines the creation/search forms, graph canvas, inspector, dialogs, and script entry point. `styles.css` controls layout, responsive behavior, forms, graph panels, status, and result cards. They contain no backend methods.

## Tests

- `tests/test_api.py` — default deterministic embedding fixture; CRUD, persistence, validation, revision conflicts, rollback, isolation, caching, and ranking.
- `tests/test_browser.py` — opt-in Playwright end-to-end workflow using an isolated temporary database (`RUN_BROWSER_TESTS=1`).
- `tests/test_local_model.py` — opt-in real FastEmbed/Kùzu integration (`RUN_MODEL_TESTS=1`).

Run standard tests with `python -m pytest -q`. Use one Uvicorn process per `data` directory because Kùzu locks its database.
