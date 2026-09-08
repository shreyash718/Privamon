import os
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from schemas import InterpretRequest, InterpretResponse
from model_client import run_inference, get_vlm_provider, get_model_for_provider
from audit_logger import log_turn

app = FastAPI(title="Privamon Server-Side Reasoning Agent")

# Allow CORS for Chrome extensions and local tools
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static directory if present
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir, html=True), name="static")

@app.post("/interpret", response_model=InterpretResponse)
async def interpret(req: InterpretRequest):
    """
    Core reasoning agent endpoint:
    - Receives sanitized screenshot, DOM context, detection summary, and prior actions.
    - Executes reasoning pipeline with self-validation and internal retry.
    - Logs confidence, assumptions, and action to audit_log.jsonl.
    - Returns strictly valid InterpretResponse contract.
    """
    try:
        response, latency_ms, retried = run_inference(
            image_b64=req.get_screenshot(),
            task=req.task,
            sanitized_dom=req.get_sanitized_dom(),
            detection_summary=req.get_detection_summary(),
            prior_actions=req.priorActions,
            conversation_state=req.conversationState
        )
    except Exception as e:
        print(f"[!] Server Error in /interpret: {e}")
        raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")

    # Attach runtime metadata for frontend inspection
    prov = response.provider or get_vlm_provider()
    response.provider = prov
    response.model = response.model or get_model_for_provider(prov)
    response.latency_ms = latency_ms

    # Audit logging for evaluation compliance
    log_turn(
        task=req.task,
        action=response.action.model_dump(),
        confidence=response.confidence,
        assumptions=response.assumptions,
        needs_clarification=response.needsClarification,
        reasoning=response.reasoning,
        latency_ms=latency_ms,
        retried=retried
    )

    return response

@app.get("/health")
async def health():
    provider = get_vlm_provider()
    return {
        "status": "ok",
        "agent": "Privamon Server-Side Reasoning Agent",
        "provider": provider,
        "model": get_model_for_provider(provider)
    }