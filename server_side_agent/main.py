import json, re
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from schemas import InterpretRequest, InterpretResponse, Action
from model_client import run_inference

app = FastAPI(title="Vision Agent Server")

# Allow CORS for browser extension and local tools
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve the static dummy frontend at the root URL
app.mount("/static", StaticFiles(directory="static", html=True), name="static")

@app.post("/interpret", response_model=InterpretResponse)
async def interpret(req: InterpretRequest):
    try:
        raw_output, thinking = run_inference(
            req.image_b64,
            req.task,
            [r.model_dump() for r in req.redacted_regions],
            req.sanitized_dom
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    actions = []
    message = None

    # Clean markdown json blocks if present
    clean_json = raw_output.strip()
    if clean_json.startswith("```"):
        clean_json = re.sub(r"^```(?:json)?\s*", "", clean_json)
        clean_json = re.sub(r"\s*```$", "", clean_json)

    try:
        parsed = json.loads(clean_json)
        if isinstance(parsed, dict):
            raw_actions = []
            if "actions" in parsed and isinstance(parsed["actions"], list):
                raw_actions = parsed["actions"]
            elif "type" in parsed or "action" in parsed:
                raw_actions = [parsed]

            for a in raw_actions:
                if isinstance(a, dict):
                    action_type = a.get("type") or a.get("action") or "click"
                    reason = a.get("reasoning") or a.get("description") or a.get("target") or ""
                    actions.append(Action(
                        type=action_type,
                        target_bbox=a.get("target_bbox"),
                        value=a.get("value"),
                        reasoning=reason,
                        description=a.get("description"),
                        target=a.get("target")
                    ))
            
            if "reasoning" in parsed and not thinking:
                thinking = str(parsed["reasoning"])
            if "message" in parsed:
                message = str(parsed["message"])
        elif isinstance(parsed, list):
            for a in parsed:
                if isinstance(a, dict):
                    action_type = a.get("type") or a.get("action") or "click"
                    reason = a.get("reasoning") or a.get("description") or a.get("target") or ""
                    actions.append(Action(
                        type=action_type,
                        target_bbox=a.get("target_bbox"),
                        value=a.get("value"),
                        reasoning=reason,
                        description=a.get("description"),
                        target=a.get("target")
                    ))
    except Exception:
        # Model returned natural language text instead of JSON
        pass

    # Synthesize clean user message if not already set
    if not message:
        if actions:
            step_descs = []
            for i, act in enumerate(actions, 1):
                loc = f" at {act.target_bbox}" if act.target_bbox else ""
                val = f' with value "{act.value}"' if act.value else ""
                why = f" ({act.reasoning})" if act.reasoning else ""
                step_descs.append(f"{i}. {act.type.upper()}{loc}{val}{why}")
            message = "Recommended actions:\n" + "\n".join(step_descs)
        elif raw_output:
            message = raw_output

    return InterpretResponse(
        actions=actions,
        raw_model_output=raw_output,
        thinking=thinking or None,
        message=message
    )

@app.get("/health")
async def health():
    return {"status": "ok"}