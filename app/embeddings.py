from pathlib import Path
from threading import Lock


class EmbeddingService:
    """Lazy, CPU-only local embeddings. No model download during graph creation."""

    dimensions = 384

    def __init__(self, model_name: str, cache_dir: Path):
        self.model_name = model_name
        self.cache_dir = cache_dir
        self._model = None
        self._lock = Lock()

    def _load(self):
        if self._model is None:
            from fastembed import TextEmbedding

            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self._model = TextEmbedding(
                model_name=self.model_name, cache_dir=str(self.cache_dir), threads=4
            )
        return self._model

    def _vectors(self, vectors):
        result = [vector.tolist() for vector in vectors]
        if any(len(vector) != self.dimensions for vector in result):
            raise ValueError("The configured embedding model must produce 384-dimensional vectors.")
        return result

    def documents(self, texts: list[str]) -> list[list[float]]:
        with self._lock:
            return self._vectors(self._load().passage_embed(texts))

    def query(self, text: str) -> list[float]:
        with self._lock:
            return self._vectors(self._load().query_embed(text))[0]

    @property
    def loaded(self):
        return self._model is not None
