# Graph Studio

Graph Studio is a local knowledge-graph application built with FastAPI, Kùzu, and local FastEmbed vector search.

## Run the application after downloading the project

These steps assume that every project file and folder was downloaded **except `.venv`**.

### Windows PowerShell

1. Install **Python 3.11** and make sure `python` or `py` works in PowerShell.
2. Open PowerShell in the project folder (the folder containing `requirements.txt`).
3. Create a new virtual environment:

   ```powershell
   py -3.11 -m venv .venv
   ```

4. Activate it:

   ```powershell
   .\.venv\Scripts\Activate.ps1
   ```

   If PowerShell blocks activation, run PowerShell as your user and execute:

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

   Then run the activation command again.

5. Install the application dependencies:

   ```powershell
   python -m pip install -r requirements.txt
   ```

6. Configure the application. If `.env` was not downloaded, create it from the example:

   ```powershell
   Copy-Item .env.example .env
   ```

   The default settings work locally and do not require an API key.

7. Start the server. Use one worker/process because the application uses an embedded Kùzu database:

   ```powershell
   python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
   ```

8. Open the application in a browser:

   **http://127.0.0.1:8000**

Keep the PowerShell window open while using the application. Press **Ctrl+C** to stop the server.

## First vector search

Semantic (lexical) and Cypher searches work immediately. The first vector search downloads the local `BAAI/bge-small-en-v1.5` embedding model, so an internet connection is required once. The model is cached in `data/models` for later use.

To download/check the model before opening the application:

```powershell
python scripts/warm_model.py
```

## Backend search API

`POST /api/graphs/{id}/search` searches the selected **saved** graph. Send `query`,
`mode` (`vector`, `semantic`, or `cypher`), and an optional `limit` (default 5,
range 1–100). The default mode is `vector`. The old `keyword` and `hybrid` mode
names are no longer accepted.

- **Vector:** embeds node **names only**, using the existing local FastEmbed
  service, and ranks with Kùzu cosine similarity. The versioned fingerprint
  includes the model and name, so older name/type/description embeddings are
  refreshed. Unchanged saves preserve the cache; description and type edits do
  not require re-embedding because they are not part of the vector document.
  Model failures return HTTP 503.
- **Semantic:** performs case-insensitive word/token matching against names only;
  it never calls the embedding model or searches descriptions, types, or UUIDs.
  Unicode NFKC normalization and case folding precede tokenization; punctuation
  and underscores separate words. Exact word matches score 1 each, while a
  one-to-one substring match receives its length ratio, and the final score is
  the weighted Dice value `2 * matched_weight / (query_tokens + name_tokens)`.
  Only positive matches are returned; a query without tokens returns no matches.
- Both modes accept `node_type_id` belonging to the selected graph, break score
  ties by UUID, and return `results` containing `id` (UUID), `name`, `score`,
  `description`, `type_id`, `type_name`, and `connections`. The response also
  includes `mode`, `revision`, `indexed_nodes`, and `model` (null for Semantic).

### Read-only Cypher subset

Cypher returns `columns` and positional `rows`, plus `mode`, `revision`,
`indexed_nodes: 0`, and `model: null`. The smaller of the request limit, a query
`LIMIT`, and 100 bounds the rows; execution has a five-second timeout.

```cypher
MATCH (n:Entity) WHERE lower(n.name) CONTAINS 'alice' RETURN n
MATCH (n {uuid: '00000000-0000-0000-0000-000000000001'}) RETURN n.name, n.id
MATCH (a:Entity)-[r:Link]->(b:Entity)
WHERE r.name = 'WORKS_AT'
RETURN a.name AS source, r.name AS relationship, b.name AS target
ORDER BY source LIMIT 25
```

- Supports one `MATCH` with comma-separated patterns and fixed-length paths,
  optional `WHERE`, `RETURN` (including `DISTINCT`, `*`, and `AS`), optional
  `ORDER BY`, and optional integer `LIMIT`. A trailing semicolon is allowed.
- Nodes are `Entity`; relationships are `Link`. Omitted labels default to these
  tables. Relationship patterns use brackets (`-[r]->`, `<-[r]-`, or `-[r]-`);
  anonymous nodes/relationships are allowed. Graph-defined type names are **not**
  labels. `r.name` resolves the relationship type's name through a scoped join.
- Node properties: `id` (or `uuid`) and `name` may be filtered or returned;
  `description` may be returned with node results. Relationship `name` may be
  filtered or returned. Whole nodes and
  relationships return public snapshot objects, without internal database fields
  or embeddings. Scalar returns automatically include each matched node's
  description; anonymous node columns have reserved `__entity...` names.
  `DISTINCT` applies to the complete returned row, including these descriptions.
- Predicates support property maps, comparisons, `CONTAINS`, `STARTS WITH`,
  `ENDS WITH`, literal `IN` lists, `IS [NOT] NULL`, `AND`, `OR`, `NOT`, parentheses,
  and `lower()`/`upper()`. Text comparisons are case-sensitive unless normalized
  explicitly. Use single- or double-quoted strings and backslash-escaped quotes.
  Expression nesting is limited to 16 levels.
- The server compiles the allowlisted syntax into parameterized queries, applies
  graph scope to **every** node, relationship, and type join, and executes in a
  read-only transaction. User text is never executed directly. Mutations,
  procedures, and database commands return 403; unsupported labels/properties
  and functions return 422; malformed/unsupported syntax and runtime errors
  return 400; timeouts return 408. Comments, quoted identifiers, aggregates,
  subqueries, variable-length paths, and additional clauses are unsupported.
- Cypher rejects the request-level `node_type_id`; graph type fields are not part
  of the allowed Cypher filter surface. All modes check graph revisions and return 409 if the saved
  snapshot changes during preparation, or 404 if the graph initially does not exist.

## Important files and data

- `data/knowledge.kuzu` contains saved graphs.
- `data/models` contains the local embedding-model cache.
- `.env` contains local configuration; `.env.example` documents the defaults.
- Stop the server before copying or backing up the `data` folder.
- Do not run multiple server processes against the same `data` folder.

## Troubleshooting

### Port 8000 is already in use

Stop the process using port 8000, or start the application on another port:

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Then open **http://127.0.0.1:8001**.

### Kùzu lock error

Another Graph Studio process is using the database. Stop the existing server, then start Graph Studio again. Do not delete `data/knowledge.kuzu` or its `.wal` file while the server is running.

## Optional: run tests

Install development dependencies and run the test suite:

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

API documentation is available at **http://127.0.0.1:8000/docs** while the server is running.
# custom_kb_check
