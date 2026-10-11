"""Download/cache the configured model and validate its embedding dimensions."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import os

from app.embeddings import EmbeddingService
from app.main import configured_path


if __name__ == "__main__":
    service = EmbeddingService(os.getenv("KG_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"), configured_path("KG_MODEL_CACHE", "data/models"))
    vectors = service.documents(["A scientist researches solar energy."])
    query = service.query("renewable power research")
    print(f"Ready: {service.model_name}; document dimensions={len(vectors[0])}; query dimensions={len(query)}")
