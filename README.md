# Graph Studio

Graph Studio is a local knowledge-graph application built with FastAPI, Kùzu, and local FastEmbed semantic search.

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

## First semantic search

Keyword search works immediately. The first semantic or hybrid search downloads the local BGE embedding model, so an internet connection is required once. The model is cached in `data/models` for later use.

To download/check the model before opening the application:

```powershell
python scripts/warm_model.py
```

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
