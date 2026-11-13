"""FastAPI app for the SPHEREx blink viewer.

Later tasks add the frame routes; for now this only exposes /health.
"""

from fastapi import FastAPI

app = FastAPI(title="SPHEREx Blink")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
