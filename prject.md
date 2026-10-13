# Graph Studio — Project Map

## Purpose

Graph Studio is a local knowledge-graph editor and search application. A user creates graphs, defines node and relationship types, adds nodes and directed connections, saves them to an embedded Kùzu database, and searches saved nodes with vector embeddings, word/token name similarity, or a safe read-only Cypher query.

**Stack:** Python 3.11, FastAPI/Uvicorn, Pydantic, Kùzu, FastEmbed, vanilla browser JavaScript, SVG, and CSS. There is no external API requirement; vector search uses a locally cached `BAAI/bge-small-en-v1.5` model, while semantic name matching works without a model.

## Directory map

```text
app/
  main.py                 FastAPI app factory, lifecycle, configuration, routes
  models.py               Pydantic API contracts and graph validation
  store.py                Kùzu schema, queries, persistence, transactions
  search.py               Vector, semantic name, and read-only Cypher search
  embeddings.py           Lazy, thread-safe local embedding adapter
  __init__.py             Python package marker
  static/
    index.html            Application markup and controls
    app.js                Browser state, editing, API calls, drafts, search UI
    graph.js              Reusable SVG graph canvas and pointer interactions
    styles.css            Layout, form, graph, status, and responsive styles
scripts/
  warm_model.py           Optional model download and dimension check
tests/
  test_api.py             Main deterministic API and persistence tests
  test_browser.py         Opt-in Playwright end-to-end test
  test_local_model.py     Opt-in real FastEmbed integration test
.env.example              Local configuration defaults
.gitignore                Excludes virtualenv, local env, runtime data, caches, and test artifacts
requirements.txt          Runtime dependency pins
requirements-dev.txt      Test/development dependency pins
README.md                 Setup, run, troubleshooting, and test commands
STARTED.md                Existing handoff summary
prject.md                 This compact architecture and workflow reference
```

`.env` and `.venv/` are local-only. `data/` is generated state and must not be copied or modified while the server is running. The application expects one Uvicorn process per data directory because Kùzu takes an exclusive database lock.

`data/knowledge.kuzu` is the durable graph database; `data/models/` is the FastEmbed cache; `data/server.log` and `data/server-error.log` are runtime logs. These generated files are intentionally ignored by Git. `.env` is the developer's local override of `.env.example` and must never be committed.

## Runtime data model

- `Graph`: graph metadata, UUID, name, revision, timestamps.
- `NodeType`: allowed entity category scoped to a graph.
- `RelationshipType`: directed mapping from one node type to another.
- `Entity`: user node with name, description, optional `FLOAT[384]` embedding of the node name, and embedding fingerprint.
- `Link`: directed edge between two `Entity` records, with relationship type and graph scope.

All IDs are UUID strings. `GraphSave.revision` is optimistic concurrency control: every save or delete must use the latest saved revision. A successful save increments the revision.

## Backend responsibilities

### `app/main.py`

Application composition and HTTP boundary. `create_app()` accepts an optional data directory and embedding service so tests can isolate storage and inject deterministic vectors.

| Function | Responsibility |
|---|---|
| `configured_path(name, fallback)` | Reads a path from environment variables; resolves relative paths against the repository root. |
| `create_app(data_dir=None, embeddings=None)` | Builds FastAPI, installs lifespan and error handling, mounts static files, and registers routes. |
| `lifespan(app)` | Startup: creates `GraphStore` and `EmbeddingService`; shutdown: closes Kùzu. |
| `database_error(request, exc)` | Converts unexpected database `RuntimeError`s to a safe HTTP 500 response while retaining the browser draft. |
| `health(request)` | Reports service, database, model name, and whether the model is loaded. |
| `list_graphs(request)` | Returns graph summaries. |
| `create_graph(body, request)` | Creates an empty graph from `GraphCreate`. |
| `get_graph(graph_id, request)` | Returns one complete graph. |
| `save_graph(graph_id, body, request)` | Validates and atomically persists a `GraphSave`. |
| `delete_graph(graph_id, request, revision)` | Deletes a graph only for the supplied revision. |
| `search(graph_id, body, request)` | Delegates search to `search_graph()`. |
| `index()` | Serves `app/static/index.html`. |

### `app/models.py`

Defines strict request/response shapes. Unknown fields are rejected by `StrictModel`; names and search text are trimmed and length-limited.

| Type/function | Responsibility |
|---|---|
| `Name` | Shared non-empty, trimmed, 1–120 character string constraint. |
| `StrictModel` | Base Pydantic model with `extra="forbid"`. |
| `GraphCreate` | New graph name request. |
| `NodeType` | UUID and node-type name. |
| `RelationshipType` | Relationship name plus source/target node-type UUIDs. |
| `Node` | Entity UUID, type UUID, name, and description. |
| `Edge` | Edge UUID, relationship-type UUID, source UUID, and target UUID. |
| `GraphSave` | Complete graph snapshot with revision and bounded collection sizes. |
| `GraphSave.valid_graph()` | Rejects duplicate IDs/names, missing type/node references, invalid endpoint types, and duplicate mappings. Allows self-relationships when their types are valid. |
| `SearchRequest` | Query, `vector`/`semantic`/`cypher` mode, 1–100 limit, and optional node-type filter for node modes. |

### `app/store.py` — `GraphStore`

Owns the embedded Kùzu database. Every query is parameterized and every record is scoped by `graph_id`. `RLock` serializes operations within the process.

| Function | Responsibility |
|---|---|
| `now()` | Returns the current UTC ISO timestamp. |
| `GraphStore.__init__(directory, memory_mb)` | Creates the database directory, opens Kùzu, creates the five tables, and gives a clear message for lock conflicts. |
| `close()` | Closes the Kùzu connection and database. |
| `query(statement, params)` | Executes a parameterized statement and converts result rows to dictionaries. |
| `transaction()` | Context manager that commits on success and rolls back on any exception. |
| `metadata(graph_id)` | Returns graph metadata or raises HTTP 404. |
| `unique_name(name, graph_id)` | Enforces case-insensitive graph-name uniqueness. |
| `list_graphs()` | Returns graph summaries sorted by name. |
| `create(name)` | Creates a UUID graph at revision 0 and returns its full representation. |
| `get(graph_id)` | Assembles metadata, types, nodes, and edges for one graph. |
| `clear(graph_id)` | Removes graph-owned entities, relationships, and node types before replacement. |
| `save(graph_id, payload)` | Checks revision and cross-graph UUID ownership, preserves valid node embeddings, transactionally replaces the snapshot, increments revision, and returns it. |
| `delete(graph_id, revision)` | Revision-checks and permanently removes the graph and all owned records. |

### `app/embeddings.py` — `EmbeddingService`

Lazy CPU-only adapter around FastEmbed. Graph creation never downloads a model.

| Function/property | Responsibility |
|---|---|
| `__init__(model_name, cache_dir)` | Stores model/cache configuration and creates no model yet. |
| `_load()` | Creates the FastEmbed model on first use and ensures the cache directory exists. |
| `_vectors(vectors)` | Converts model vectors to lists and enforces 384 dimensions. |
| `documents(texts)` | Embeds node documents under a thread lock. |
| `query(text)` | Embeds one search query under a thread lock. |
| `loaded` | Reports whether the model has been initialized. |

### `app/search.py`

`search_graph(store, embeddings, graph_id, request)` loads the saved graph, validates an optional type filter, and searches only that graph. Vector mode embeds each node `name` only, hashes it with the model name and input version, embeds only missing/stale names, and stores unit-normalized vectors transactionally. It ranks with Kùzu cosine similarity and returns both `score` and `distance` (`distance = 1 - score`). A vector score is semantic closeness in embedding space, not a percentage of shared words: related terms such as `table` and `column` can score similarly when the query is `table 1`; exact lexical overlap still determines the higher result only indirectly through the model. Semantic mode is the literal word/token mode: it normalizes names, matches exact words and one-to-one substrings, and computes a deterministic weighted Dice score without loading the model. Therefore, use Vector for meaning/context and Semantic for stronger word-level separation. Cypher mode compiles an allowlisted read-only subset, scopes Entity/Link/type joins to the selected graph, adds node descriptions to scalar results, and caps output at 100 rows. Node results include scores, UUIDs, descriptions, node type, revision, refreshed-node count, and all connected relationships. Model failures return HTTP 503; invalid Cypher returns a safe 4xx; stale graph changes return HTTP 409.

## Frontend responsibilities

### `app/static/index.html`

Declares the sidebar graph list, welcome screen, creation forms, relationship editor, SVG canvas, inspector, search tab, dialogs, status areas, and the ES-module entry point. It contains markup only; backend behavior lives in `app.js`.

### `app/static/app.js`

The single-page UI controller. `state` contains the selected graph, saved snapshot, dirty flag, edit selections, and search response. Browser drafts are stored under `graph-studio:draft:<graph-id>` in `localStorage`; only explicit Save writes to Kùzu.

| Function | Responsibility |
|---|---|
| `$`, `escape`, `uuid`, `draftKey` | DOM lookup, HTML escaping, UUID generation, and draft-key helpers. |
| `notify(message, error, persistent)` | Shows timed or persistent success/error notices. |
| `api(path, options)` | Calls `/api` endpoints, parses JSON, and normalizes FastAPI errors. |
| `busy(action)` | Serializes UI operations, disables controls, handles errors, and restores status. |
| `payload(graph)` | Selects the graph fields accepted by `GraphSave`. |
| `readDraft(id)` / `removeDraft(id)` | Safely load or delete a valid local draft. |
| `changed()` | Marks the graph dirty, stores a draft, clears old search results, and rerenders. |
| `setOptions(id, items, empty)` | Rebuilds a select while preserving a valid selection. |
| `searchCopy`, `updateSearchMode()` | Provides mode-specific labels, help, placeholders, model guidance, and control visibility for Vector, Semantic, and Cypher search. |
| `renderNodeResults(response, mode)` | Safely renders ranked node name, UUID, score, vector distance when applicable, description, type, and connections. |
| `renderCypherResults(response)` | Safely renders Cypher columns and rows in a bounded, responsive table. |
| `nodeLabel`, `nodeOptions`, `nodeTypeName`, `relType`, `nodeById` | Format node choices and look up graph entities/types. |
| `resolveNode(value, allowed)` | Resolves a node by UUID or name; rejects ambiguous names and wrong endpoint types. |
| `renderSidebar()` | Renders graph navigation and draft indicators. |
| `renderStatus()` | Renders saved/unsaved state and enables Save only when dirty. |
| `renderMapping()` | Updates relationship endpoint choices, hints, and create/edit button state. |
| `render()` | Renders the complete current graph into forms, summaries, legend, canvas, and search filters. |
| `renderInspector()` | Displays selected node/edge details and edit actions. |
| `refreshGraphs()` | Fetches the graph list. |
| `openGraph(id, useDraft)` | Loads saved data, optionally restores a draft, resets editors, and renders the graph. |
| `showGraphDialog()` | Opens and resets the new-graph dialog. |
| `switchTab(tab)` | Switches Creation/Search panels and refits the canvas when needed. |
| `onForm(id, handler)` | Adds common submit prevention, busy checks, and error handling. |
| `uniqueName(name, collection, ignoreId)` | Validates non-empty, max-length, case-insensitive unique names. |
| `resetRelTypeForm()` | Clears relationship-definition edit state and resets its button. |
| `cancelMapping()` | Clears relationship mapping edit state and node inputs. |
| `loadNode(id)` | Loads a node into the update form and selects it on the canvas. |
| `loadEdge(id)` | Loads an edge into the mapping form and selects it on the canvas. |

Event handlers wire graph creation/list navigation, save/reload/delete, tabs, type/relationship/node CRUD, mapping CRUD, canvas controls, search submission, UUID copy, result navigation, and the unsaved-changes browser warning. Node/type edits protect existing relationship endpoint validity; deleting a node removes its connected edges.

### `app/static/graph.js` — `GraphCanvas`

Renders the current graph as accessible SVG with type colors, directed arrows, labels, selection, filtering, zoom, pan, and drag positioning.

| Function/method | Responsibility |
|---|---|
| `svgElement(tag, attributes, text)` | Creates a namespaced SVG element safely. |
| `GraphCanvas.constructor(svg, onSelect)` | Initializes graph state and wheel, pointer, keyboard, and resize handlers. |
| `localPoint(event)` | Converts browser coordinates to SVG-local coordinates. |
| `setGraph(graph)` | Loads graph data, creates default circular positions, removes deleted positions, renders, and fits. |
| `layout()` | Resets positions and refits the graph. |
| `fit()` | Calculates a viewport transform containing all nodes. |
| `zoom(factor, point)` | Zooms around a cursor/viewport point within safe limits. |
| `transform()` | Applies the current translation and scale to the SVG layer. |
| `select(kind, id)` | Stores selection, rerenders, and notifies `app.js`. |
| `highlight(query)` | Sets a case-insensitive node filter and rerenders dimmed items. |
| `pointerDown/Move/Up(event)` | Selects items, drags nodes, pans the background, and releases pointer capture. |
| `render()` | Draws edges, self-links, labels, nodes, accessibility attributes, selection, and filter state. |

### `app/static/styles.css`

Defines design tokens and all visual behavior: sidebar, cards, forms, buttons, graph canvas, inspector, search results, notices, dialogs, focus states, and responsive layouts for desktop, tablet, and mobile. It has no application logic.

## Main workflows

### 1. Startup

1. `app.main:app` imports configuration from `.env`.
2. FastAPI lifespan opens `data/knowledge.kuzu`, creates missing schema tables, and initializes a lazy embedding service.
3. The browser loads `/`, calls `GET /api/graphs`, restores the last graph and any local draft, or shows the welcome state.
4. Shutdown closes the Kùzu connection. Do not run a second process against the same data directory.

### 2. Create and edit a graph

1. Create with `POST /api/graphs`; the server assigns a UUID and revision `0`.
2. Add node types, directed relationship definitions, nodes, and mappings in browser state. IDs are generated client-side.
3. Each edit calls `changed()`, which writes a recoverable local draft but does not persist it remotely.
4. Save sends the complete snapshot with its saved revision. Pydantic validates structure; `GraphStore.save()` checks ownership, preserves reusable embeddings, replaces records in one transaction, and increments the revision.
5. Reload discards the draft. Delete sends the saved revision and removes all graph-owned data.

### 3. Search

1. Search always uses the saved graph, not unsaved browser edits; the UI shows a warning when dirty.
2. `semantic` compares words/tokens in node names and returns lexical scores without a model. Exact word overlap is weighted more strongly than partial matches.
3. `vector` lazily loads/downloads FastEmbed, refreshes only changed/missing name embeddings, and runs Kùzu cosine search. Its score expresses embedding-space meaning, not literal word overlap; semantically related names can therefore have close scores.
4. `cypher` accepts one allowlisted read-only MATCH query, returns columns/rows, scopes the selected graph, and shows errors inline.
5. A first vector-model failure is reported as 503 while semantic and Cypher search remain available.

### 4. Conflict and failure safety

- A stale save/delete is rejected with 409; the local draft remains available.
- Invalid graph references, duplicate names/IDs, foreign UUID reuse, and invalid relationship endpoints are rejected with 422.
- Store writes use a transaction; an insertion failure rolls back the full replacement.
- Search checks the graph revision before and after embedding preparation to avoid returning results from a changed snapshot.
- The UI disables concurrent operations and warns before unloading dirty drafts.

## API surface

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Service, Kùzu, and model status. |
| `GET` | `/api/graphs` | List graphs. |
| `POST` | `/api/graphs` | Create `{name}`. |
| `GET` | `/api/graphs/{id}` | Read complete graph. |
| `PUT` | `/api/graphs/{id}` | Atomically save `GraphSave`. |
| `DELETE` | `/api/graphs/{id}?revision=N` | Revision-protected delete. |
| `POST` | `/api/graphs/{id}/search` | Run `SearchRequest`. |

## Scripts, tests, and operating commands

### `scripts/warm_model.py`

Creates an `EmbeddingService`, embeds one document and one query, and prints both dimensions. Run it before using vector search when you want to download/validate the model explicitly.

### Tests

- `tests/test_api.py`: deterministic 384-dimensional vectors isolate API behavior from model downloads. Covers CRUD, restart persistence, graph isolation, validation, revision conflicts, rollback, vector/semantic ranking, name-only embedding cache invalidation, model failure, and self-relationships.
- `tests/test_search.py`: search-specific coverage for default/configurable limits, lexical scores, vector name-only behavior, cache restart/model changes, invalid embeddings, revision races, Cypher scoping/descriptions, row caps, and invalid queries.
- `tests/test_browser.py`: skipped unless `RUN_BROWSER_TESTS=1`; launches an isolated Uvicorn app and Playwright browser to cover creation, draft restore, save/reload, editing, search, deletion, responsive layout, and graph isolation.
- `tests/test_local_model.py`: skipped unless `RUN_MODEL_TESTS=1`; uses the real local FastEmbed model and Kùzu vector search.

From the repository root:

```powershell
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
python -m pip install -r requirements-dev.txt
python -m pytest -q
python scripts/warm_model.py
```

Open `http://127.0.0.1:8000`; OpenAPI is at `/docs`. Optional checks use `RUN_BROWSER_TESTS=1 python -m pytest tests/test_browser.py -q` and `RUN_MODEL_TESTS=1 python -m pytest tests/test_local_model.py -q`. Model checks need the model cache/internet on first use; browser checks need a usable Playwright Chromium installation.

### Configuration

`.env.example` documents `KG_DATA_DIR`, `KG_MODEL_CACHE`, `KG_EMBEDDING_MODEL`, and `KG_DB_MEMORY_MB`. Relative paths are rooted at the repository. No API keys are required. `requirements.txt` pins runtime dependencies; `requirements-dev.txt` adds test tooling.

## Change guide for new sessions

1. Read this file and `README.md`; inspect `STARTED.md` only for the older handoff narrative.
2. For data/API behavior, start in `models.py`, then `store.py`, then `main.py` routes; update deterministic API tests.
3. For search behavior, update `search.py` and its API/model tests; preserve 384-dimensional vectors and embedding fingerprints.
4. For UI behavior, update `index.html` for structure, `app.js` for state/API/editing, `graph.js` for canvas behavior, and `styles.css` for presentation; update the browser test for user-visible flows.
5. Preserve revision checks, graph scoping, transaction boundaries, and local-draft recovery unless the requirement explicitly changes them.
6. Run `python -m pytest -q` after code changes; run the opt-in browser/model checks when their dependencies and environment are available.
