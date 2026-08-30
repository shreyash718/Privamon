import json
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from schemas import InterpretRequest, InterpretResponse, Action
from model_client import run_inference

app = FastAPI(title="Vision Agent Server")

# Serve the static dummy frontend at the root URL
app.mount("/static", StaticFiles(directory="static", html=True), name="static")

@app.post("/interpret", response_model=InterpretResponse)
async def interpret(req: InterpretRequest):
    try:
        raw_output = run_inference(
            req.image_b64,
            req.task,
            [r.model_dump() for r in req.redacted_regions],
            req.sanitized_dom
        )
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail=str(e))

    try:
        parsed = json.loads(raw_output)
        actions = [Action(**a) for a in parsed.get("actions", [])]
    except Exception:
        actions = []

    return InterpretResponse(actions=actions, raw_model_output=raw_output)

@app.get("/health")
async def health():
    return {"status": "ok"}