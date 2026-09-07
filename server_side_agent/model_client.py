import requests, json, io, base64, re, time
from typing import Optional, Union, Any
from PIL import Image
from pydantic import ValidationError
from schemas import InterpretResponse, ActionPayload

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL_NAME = "qwen3-vl:2b"

def optimize_image_b64(b64_str: str, max_dimension: int = 512) -> str:
    """
    Optimizes base64 screenshot for VLM consumption:
    - Downscales images larger than max_dimension to cut token count
    - Converts to high-quality JPEG to minimize memory and transmission overhead
    """
    if not b64_str:
        return ""
    try:
        # Strip data URL header if present
        clean_b64 = b64_str.split(",", 1)[1] if "," in b64_str and b64_str.startswith("data:") else b64_str
        raw_bytes = base64.b64decode(clean_b64)
        img = Image.open(io.BytesIO(raw_bytes))
        
        # Convert RGBA / palette to RGB
        if img.mode in ("RGBA", "P", "LA"):
            background = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == "P":
                img = img.convert("RGBA")
            background.paste(img, mask=img.split()[-1] if "A" in img.mode else None)
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")
            
        w, h = img.size
        if max(w, h) > max_dimension:
            scale = max_dimension / max(w, h)
            new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
            img = img.resize(new_size, Image.Resampling.LANCZOS)
            
        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=85, optimize=True)
        return base64.b64encode(buffer.getvalue()).decode("utf-8")
    except Exception as e:
        print(f"[!] Warning: Image optimization failed: {e}. Using raw image.")
        return b64_str.split(",", 1)[1] if "," in b64_str and b64_str.startswith("data:") else b64_str

def format_dom_for_prompt(sanitized_dom: Union[list, str, None], max_elements: int = 40) -> str:
    """
    Formats the sanitized DOM context into structured text lines containing
    elementIds, tags, labels, and text so the model grounds actions in exact DOM IDs.
    """
    if not sanitized_dom:
        return "(No DOM elements available)"
    if isinstance(sanitized_dom, str):
        return sanitized_dom[:2500]
    
    lines = []
    for el in sanitized_dom[:max_elements]:
        el_id = el.get("elementId") or el.get("id") or "unknown"
        tag = el.get("tag") or "elem"
        role = f" role=\"{el.get('role')}\"" if el.get("role") else ""
        label = f" label=\"{el.get('label')}\"" if el.get("label") else ""
        text = f" text=\"{el.get('text')}\"" if el.get("text") else ""
        attrs = el.get("attributes") or {}
        val = f" value=\"{attrs.get('value')}\"" if attrs.get("value") else ""
        inp_type = f" type=\"{attrs.get('type')}\"" if attrs.get("type") else ""
        lines.append(f"- elementId: \"{el_id}\" | <{tag}{inp_type}{role}{label}{val}>{text}</{tag}>")
        
    return "\n".join(lines)

def build_reasoning_prompt(
    task: str,
    sanitized_dom: Union[list, str, None] = None,
    detection_summary: dict = None,
    prior_actions: list = None,
    conversation_state: dict = None
) -> str:
    """
    Constructs the system prompt following the Privamon Server-Side Reasoning Agent specification.
    """
    dom_text = format_dom_for_prompt(sanitized_dom)
    det_text = json.dumps(detection_summary) if detection_summary else "None"
    prior_text = json.dumps(prior_actions) if prior_actions else "None"

    return f"""You are the server-side reasoning agent for Privamon. You receive a sanitized, redacted screen context (image + DOM) from a browser extension that has already stripped all PII locally. You do not receive raw pixels, passwords, or personal data — some regions of the image are solid black, and some DOM text is replaced with tokens like [REDACTED: email]. Your job is to understand the user's task, reason about the sanitized screen state, and return a structured, executable action for the browser client to carry out. You never see anything the client didn't choose to send you, so you must reason well despite missing information, not pretend it isn't missing.

USER TASK:
"{task}"

AVAILABLE SANITIZED DOM ELEMENTS (target ONLY these elementId values):
{dom_text}

DETECTION SUMMARY:
{det_text}

PRIOR ACTIONS:
{prior_text}

HOW TO REASON UNDER REDACTION:
1. Ground every action in the sanitized DOM, not the image: The image is for layout/spatial context; the DOM's elementIds are what you actually target. Never return a targetElementId that isn't present in the sanitized DOM list — if the right target isn't there, say so in assumptions and set needsClarification: true.
2. Treat [REDACTED: type] tokens as typed placeholders, not blanks: Reason about structure, not content. Only ask for clarification when the task genuinely requires knowing the redacted content itself.
3. Use black boxes in the image as landmarks, not obstacles: A solid black box indicates a profile photo or credential field; use it to understand page layout.
4. One action per response, always: Don't return multi-step plans. Return one atomic executable action.
5. Calibrate confidence honestly (0.0 to 1.0): Below 0.5, prefer action type "ask_user". Reserve "done" for when the task is verifiably complete.
6. State every assumption explicitly in the assumptions list.
7. Don't hallucinate content behind a redaction.

REQUIRED OUTPUT CONTRACT:
You must return ONLY a single valid JSON object strictly matching this schema with NO markdown code block wrapper or extra prose:
{{
  "reasoning": "1-3 sentences, plain language, no chain-of-thought dump",
  "confidence": 0.95,
  "action": {{
    "type": "click",
    "targetElementId": "dom-tok-12",
    "value": null,
    "scrollDirection": null
  }},
  "assumptions": ["inferred primary action button based on role"],
  "needsClarification": false
}}
(Valid action types: click, type, scroll, select, wait, ask_user, done. For scroll, scrollDirection can be "up" or "down".)
"""

def call_ollama(prompt: str, image_b64: str) -> tuple[str, str]:
    """
    Sends request to Ollama with streaming response support.
    """
    payload = {
        "model": MODEL_NAME,
        "prompt": prompt,
        "format": "json",
        "stream": True,
        "options": {
            "num_ctx": 4096,
            "num_predict": 512,
            "temperature": 0.2
        }
    }
    if image_b64:
        payload["images"] = [image_b64]

    print(f"[*] Sending request to Ollama ({MODEL_NAME}) with context size 4096...")
    resp = requests.post(OLLAMA_URL, json=payload, stream=True, timeout=180)
    
    if resp.status_code != 200:
        raise Exception(f"Ollama API error {resp.status_code}: {resp.text}")
        
    full_response = ""
    full_thinking = ""
    
    for line in resp.iter_lines():
        if line:
            chunk = json.loads(line)
            if "thinking" in chunk and chunk["thinking"]:
                full_thinking += chunk["thinking"]
                print(f"\033[90m{chunk['thinking']}\033[0m", end="", flush=True)
            if "response" in chunk and chunk["response"]:
                full_response += chunk["response"]
                print(f"\033[92m{chunk['response']}\033[0m", end="", flush=True)
                
    print("\n[*] Finished generation.")
    return full_response.strip(), full_thinking.strip()

def parse_and_validate(raw_text: str) -> tuple[Optional[InterpretResponse], Optional[str]]:
    """
    Validates model output against InterpretResponse schema.
    Returns (validated_object, error_message).
    """
    if not raw_text:
        return None, "Empty response received from model"

    clean = raw_text.strip()
    # Strip markdown block if present
    if "```" in clean:
        clean = re.sub(r"^```(?:json)?\s*", "", clean, flags=re.MULTILINE)
        clean = re.sub(r"\s*```$", "", clean, flags=re.MULTILINE)

    # Extract JSON bracket match
    match = re.search(r"\{.*\}", clean, re.DOTALL)
    if match:
        clean = match.group(0)

    try:
        data = json.loads(clean)
    except Exception as e:
        return None, f"JSON parse error: {e}"

    if not isinstance(data, dict):
        return None, "Root JSON must be an object"

    # Normalize legacy {"actions": [...]} if model slipped into older output format
    if "actions" in data and isinstance(data["actions"], list) and data["actions"]:
        first = data["actions"][0]
        act_type = str(first.get("type", "click")).lower()
        if act_type not in ("click", "type", "scroll", "select", "wait", "ask_user", "done"):
            act_type = "click"
        data = {
            "reasoning": data.get("message") or first.get("reasoning") or "Proceeding with recommended step.",
            "confidence": float(data.get("confidence", 0.85)),
            "action": {
                "type": act_type,
                "targetElementId": first.get("targetElementId") or first.get("target") or None,
                "value": first.get("value") or None,
                "scrollDirection": first.get("scrollDirection") or None
            },
            "assumptions": data.get("assumptions") or [],
            "needsClarification": bool(data.get("needsClarification", False))
        }

    # Normalize reasoning
    if "reasoning" not in data or not data["reasoning"]:
        data["reasoning"] = data.get("message") or data.get("description") or "Action determined from screen state."

    # Normalize action object if needed
    if "action" in data and isinstance(data["action"], dict):
        act = data["action"]
        raw_type = str(act.get("type", "click")).lower()
        if raw_type not in ("click", "type", "scroll", "select", "wait", "ask_user", "done"):
            raw_type = "click"
        act["type"] = raw_type
        # Ensure null values for absent fields
        act["targetElementId"] = act.get("targetElementId") or act.get("target") or None
        act["value"] = act.get("value") or None
        direction = act.get("scrollDirection")
        if direction not in ("up", "down"):
            direction = None
        act["scrollDirection"] = direction
    elif "action" in data and isinstance(data["action"], str):
        raw_type = data["action"].lower()
        if raw_type in ("click", "type", "scroll", "select", "wait", "ask_user", "done"):
            direction = data.get("scrollDirection")
            if direction not in ("up", "down"):
                direction = None
            data["action"] = {
                "type": raw_type,
                "targetElementId": data.get("targetElementId") or data.get("target") or None,
                "value": data.get("value") or None,
                "scrollDirection": direction
            }
        else:
            return None, f"Invalid action string: '{data['action']}' is not a valid action type"
    elif "type" in data and isinstance(data["type"], str):
        raw_type = data["type"].lower()
        if raw_type not in ("click", "type", "scroll", "select", "wait", "ask_user", "done"):
            raw_type = "click"
        direction = data.get("scrollDirection")
        if direction not in ("up", "down"):
            direction = None
        data["action"] = {
            "type": raw_type,
            "targetElementId": data.get("targetElementId") or data.get("target") or None,
            "value": data.get("value") or None,
            "scrollDirection": direction
        }
    else:
        data["action"] = {"type": "ask_user", "targetElementId": None, "value": None, "scrollDirection": None}

    # Normalize confidence to [0.0, 1.0]
    try:
        conf = float(data.get("confidence", 0.85))
        data["confidence"] = max(0.0, min(1.0, conf))
    except Exception:
        data["confidence"] = 0.5

    # Normalize assumptions
    if not isinstance(data.get("assumptions"), list):
        data["assumptions"] = [str(data["assumptions"])] if data.get("assumptions") else []

    try:
        validated = InterpretResponse.model_validate(data)
        return validated, None
    except ValidationError as ve:
        return None, f"Schema validation error: {ve}"

def _populate_backward_compat(resp: InterpretResponse) -> None:
    """
    Populates legacy helper fields (actions, message, thinking) for backwards
    compatibility with existing extension popups.
    """
    act = resp.action
    target = act.targetElementId or ""
    val = act.value or ""
    direction = act.scrollDirection or ""

    desc_parts = []
    if target:
        desc_parts.append(f"Target: {target}")
    if val:
        desc_parts.append(f'Value: "{val}"')
    if direction:
        desc_parts.append(f"Direction: {direction}")

    act_reasoning = resp.reasoning
    if desc_parts:
        act_reasoning = f"{' | '.join(desc_parts)} — {resp.reasoning}"

    resp.actions = [{
        "type": act.type,
        "reasoning": act_reasoning,
        "value": val or None,
        "targetElementId": target or None,
        "scrollDirection": direction or None
    }]
    resp.message = resp.reasoning
    resp.thinking = resp.thinking or resp.reasoning

def run_inference(
    image_b64: str,
    task: str,
    sanitized_dom: Union[list, str, None] = None,
    detection_summary: dict = None,
    prior_actions: list = None,
    conversation_state: dict = None
) -> tuple[InterpretResponse, float, bool]:
    """
    Main entry point for reasoning agent execution:
    1. Optimizes screenshot resolution for efficient VLM context.
    2. Builds system prompt following the reasoning guidelines.
    3. Executes model generation.
    4. Validates output against InterpretResponse schema.
    5. Retries internally with stricter corrective prompt if first attempt fails validation.
    6. Ensures 100% compliant schema response.
    Returns: (validated_response, latency_ms, retried_boolean)
    """
    start_time = time.perf_counter()
    optimized_image = optimize_image_b64(image_b64, max_dimension=1024) if image_b64 else ""

    prompt = build_reasoning_prompt(
        task=task,
        sanitized_dom=sanitized_dom,
        detection_summary=detection_summary,
        prior_actions=prior_actions,
        conversation_state=conversation_state
    )

    # First attempt
    raw_output, thinking = call_ollama(prompt, optimized_image)
    validated, error = parse_and_validate(raw_output)
    if not validated and thinking:
        val_from_thinking, err_thinking = parse_and_validate(thinking)
        if val_from_thinking:
            validated = val_from_thinking
            error = None
        else:
            error = err_thinking

    if validated:
        latency = round((time.perf_counter() - start_time) * 1000, 2)
        validated.raw_model_output = raw_output or thinking
        validated.thinking = thinking
        _populate_backward_compat(validated)
        return validated, latency, False

    # Internal Retry with explicit corrective feedback (DO NOT resend image to avoid CPU ViT latency)
    print(f"\n[!] Model output rejected: {error}. Triggering fast internal retry with strict schema enforcement...")
    retry_prompt = (
        f"{prompt}\n\n"
        f"CRITICAL ERROR: Your previous response failed schema validation: {error}\n"
        f"Fix the error and output ONLY a valid JSON object matching the exact schema:\n"
        f'{{"reasoning": "1-3 sentences", "confidence": 0.85, "action": {{"type": "click", "targetElementId": "exact_element_id_or_null", "value": null, "scrollDirection": null}}, "assumptions": [], "needsClarification": false}}\n'
    )

    raw_retry, thinking_retry = call_ollama(retry_prompt, image_b64="")
    validated_retry, error_retry = parse_and_validate(raw_retry)
    if not validated_retry and thinking_retry:
        val_from_retry_thinking, err_retry = parse_and_validate(thinking_retry)
        if val_from_retry_thinking:
            validated_retry = val_from_retry_thinking
            error_retry = None
        else:
            error_retry = err_retry
    latency = round((time.perf_counter() - start_time) * 1000, 2)

    if validated_retry:
        validated_retry.raw_model_output = raw_retry or thinking_retry
        validated_retry.thinking = thinking_retry or thinking
        _populate_backward_compat(validated_retry)
        return validated_retry, latency, True

    # Fallback to guaranteed schema-compliant response
    print(f"\n[!] Internal retry failed ({error_retry}). Synthesizing safe schema-compliant fallback response.")
    fallback = InterpretResponse(
        reasoning="Analyzed screen context, but the requested action could not be unambiguously automated from current DOM elements. Please provide clarification.",
        confidence=0.3,
        action=ActionPayload(type="ask_user", targetElementId=None, value=None, scrollDirection=None),
        assumptions=["Model output did not conform to JSON contract after retry; requesting user clarification."],
        needsClarification=True,
        raw_model_output=raw_retry or raw_output,
        thinking=thinking_retry or thinking
    )
    _populate_backward_compat(fallback)
    return fallback, latency, True