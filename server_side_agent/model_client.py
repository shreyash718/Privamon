import os, requests, json, io, base64, re, time
from typing import Optional, Union, Any
from PIL import Image
from pydantic import ValidationError
from schemas import InterpretResponse, ActionPayload

def _load_env_file():
    """
    Lightweight, zero-dependency .env loader that reloads on demand.
    Checks server_side_agent/.env and project root .env.
    """
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"),
    ]
    for env_path in candidates:
        if os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip('"').strip("'")
                            os.environ[k] = v
            except Exception:
                pass

_load_env_file()

# Provider Configuration
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/generate")
OPENROUTER_URL = os.getenv("OPENROUTER_URL", "https://openrouter.ai/api/v1/chat/completions")

def get_vlm_provider() -> str:
    _load_env_file()
    return os.getenv("VLM_PROVIDER", "ollama").lower()

def get_openrouter_api_key() -> str:
    _load_env_file()
    return os.getenv("OPENROUTER_API_KEY", "").strip()

def get_model_for_provider(provider: str = None) -> str:
    _load_env_file()
    prov = (provider or get_vlm_provider()).lower()
    if prov == "openrouter":
        return os.getenv("VLM_MODEL_OPENROUTER", "qwen/qwen3-vl-8b-instruct")
    return os.getenv("VLM_MODEL_OLLAMA", "qwen3-vl:2b")

# Strict Action Schema enforced across Ollama and OpenRouter
# Note: additionalProperties: False is mandatory for OpenAI-compatible strict structured output APIs
STRICT_ACTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "action": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "type": {
                    "type": "string",
                    "enum": ["click", "type", "scroll", "select", "wait", "ask_user", "done"]
                },
                "targetElementId": {
                    "type": ["string", "null"],
                    "description": "The exact elementId from the available DOM list, or null"
                },
                "value": {
                    "type": ["string", "null"],
                    "description": "Text value to type/select, or null"
                },
                "scrollDirection": {
                    "type": ["string", "null"],
                    "enum": ["up", "down", None]
                }
            },
            "required": ["type", "targetElementId", "value", "scrollDirection"]
        },
        "confidence": {
            "type": "number",
            "description": "Confidence score between 0.0 and 1.0"
        },
        "assumptions": {
            "type": "array",
            "items": {"type": "string"}
        },
        "needsClarification": {
            "type": "boolean"
        },
        "reasoning": {
            "type": "string",
            "description": "1-2 brief plain language sentences explaining the action"
        }
    },
    "required": ["action", "confidence", "assumptions", "needsClarification", "reasoning"]
}

def optimize_image_b64(b64_str: str, max_dimension: int = 1152) -> str:
    """
    Optimizes base64 screenshot for VLM consumption while preserving PNG fidelity:
    - Uses lossless PNG exclusively to prevent JPEG DCT ringing artifacts around UI text and redactions.
    - If image is already <= max_dimension and in PNG format, passes it directly through.
    - If resizing or palette normalization is needed, resizes with LANCZOS and re-encodes as lossless PNG.
    """
    if not b64_str:
        return ""
    try:
        clean_b64 = b64_str.split(",", 1)[1] if "," in b64_str and b64_str.startswith("data:") else b64_str
        raw_bytes = base64.b64decode(clean_b64)
        img = Image.open(io.BytesIO(raw_bytes))
        w, h = img.size

        # If already within bounds and in PNG format, pass clean data directly
        if max(w, h) <= max_dimension and getattr(img, "format", "").upper() == "PNG":
            return clean_b64

        # Convert palette / RGBA to RGB for standard VLM consumption
        if img.mode in ("RGBA", "P", "LA"):
            background = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == "P":
                img = img.convert("RGBA")
            background.paste(img, mask=img.split()[-1] if "A" in img.mode else None)
            img = background
        elif img.mode != "RGB":
            img = img.convert("RGB")

        if max(w, h) > max_dimension:
            scale = max_dimension / max(w, h)
            new_size = (max(1, int(w * scale)), max(1, int(h * scale)))
            img = img.resize(new_size, Image.Resampling.LANCZOS)

        buffer = io.BytesIO()
        img.save(buffer, format="PNG", optimize=True)
        return base64.b64encode(buffer.getvalue()).decode("utf-8")
    except Exception as e:
        print(f"[!] Warning: Image optimization failed: {e}. Using raw image.")
        return b64_str.split(",", 1)[1] if "," in b64_str and b64_str.startswith("data:") else b64_str

def format_dom_for_prompt(sanitized_dom: Union[list, str, None], max_elements: int = None) -> str:
    """
    Formats the sanitized DOM context into structured text lines containing
    elementIds, coarse positional tags [pos: ...], tags, labels, placeholders, and text.
    Applies strict length limits per field to keep prompt token consumption minimal.
    """
    if not sanitized_dom:
        return "(No DOM elements available)"
    if isinstance(sanitized_dom, str):
        return sanitized_dom[:2500]

    limit = max_elements if max_elements is not None else int(os.getenv("VLM_DOM_MAX_ELEMENTS", "28"))
    lines = []
    for el in sanitized_dom[:limit]:
        el_id = el.get("elementId") or el.get("id") or "unknown"
        tag = el.get("tag") or "elem"
        pos = f" [pos: {el.get('pos')}]" if el.get("pos") else ""
        role = f" role=\"{el.get('role')}\"" if el.get("role") else ""
        
        raw_label = str(el.get("label") or "")
        label_val = (raw_label[:60] + "...") if len(raw_label) > 60 else raw_label
        label = f" label=\"{label_val}\"" if label_val else ""
        
        raw_text = str(el.get("text") or "").strip()
        text_val = (raw_text[:60] + "...") if len(raw_text) > 60 else raw_text
        text = f" text=\"{text_val}\"" if text_val else ""
        
        attrs = el.get("attributes") or {}
        placeholder = attrs.get("placeholder") or el.get("placeholder")
        if placeholder:
            ph_val = str(placeholder)
            ph_str = (ph_val[:50] + "...") if len(ph_val) > 50 else ph_val
            ph = f" placeholder=\"{ph_str}\""
        else:
            ph = ""
        val = f" value=\"{str(attrs.get('value'))[:50]}\"" if attrs.get("value") else ""
        inp_type = f" type=\"{attrs.get('type')}\"" if attrs.get("type") else ""
        lines.append(f"- elementId: \"{el_id}\"{pos} | <{tag}{inp_type}{role}{label}{ph}{val}>{text}</{tag}>")

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
    
    if prior_actions and isinstance(prior_actions, list):
        prior_text = "\n".join(f"- {str(act)[:100]}" for act in prior_actions[-3:])
    elif prior_actions:
        prior_text = str(prior_actions)[:250]
    else:
        prior_text = "None"

    return f"""You are the server-side reasoning agent for Privamon. You receive a sanitized, redacted screen context (image + DOM) from a browser extension that has already stripped all PII locally. You do not receive raw pixels, passwords, or personal data — some regions of the image are solid black, and some DOM text is replaced with tokens like [REDACTED: email]. Your job is to understand the user's task, reason about the sanitized screen state, and return a structured, executable action for the browser client to carry out. You never see anything the client didn't choose to send you, so you must reason well despite missing information, not pretend it isn't missing.

USER TASK:
"{task}"

AVAILABLE SANITIZED DOM ELEMENTS (target ONLY these elementId values):
{dom_text}

DETECTION SUMMARY:
{det_text}

PRIOR ACTIONS & OUTCOMES:
{prior_text}

HOW TO REASON UNDER REDACTION:
1. Ground every action in the sanitized DOM, not the image: The image is for layout/spatial context; the DOM's elementIds are what you actually target. Never return a targetElementId that isn't present in the sanitized DOM list — if the right target isn't there, say so in assumptions and set needsClarification: true.
2. Treat [REDACTED: type] tokens as typed placeholders, not blanks: Reason about structure, not content. Only ask for clarification when the task genuinely requires knowing the redacted content itself.
3. Use black boxes in the image as landmarks, not obstacles: A solid black box indicates a profile photo or credential field; use it to understand page layout.
4. One action per response, always: Don't return multi-step plans. Return one atomic executable action.
5. Calibrate confidence honestly (0.0 to 1.0): Below 0.5, prefer action type "ask_user". Reserve "done" for when the task is verifiably complete.
6. Check prior action outcomes: If a prior action has outcome 'no_change_detected', DO NOT repeat that action unchanged; adapt your strategy.
7. Keep reasoning brief: 1 to 2 concise sentences maximum.
8. State every assumption explicitly in the assumptions list.
9. Don't hallucinate content behind a redaction.

SPECIAL GUIDANCE FOR CHAT & MESSAGING:
- When the user's task asks to send a message, write a message, or type into a chat (e.g. "send message to chat which is open ...", "say ..."):
  1. Identify the open chat's message input or textbox (look for elements with role="textbox", contenteditable, or placeholder/label like "Type a message", "Message", or positioned at the bottom of the active conversation pane).
  2. Use action type "type" targeting that element's exact elementId.
  3. Extract the requested message text (e.g. text inside quotes, like "Hie") and place it into the "value" field.
  4. DO NOT click sidebar chats, contact list items, or header buttons when the chat conversation is already open on screen.
  5. CRITICAL: NEVER target a microphone or voice recording button (labeled "Voice message", "Microphone", "PTT", or "(Microphone / Voice Record Button - NOT A TEXTBOX)") for text tasks or "type" actions. A voice message button records audio from the microphone, it CANNOT accept typed text. Always target the actual TEXTBOX (labeled "Type a message", role="textbox", contenteditable).

SPECIAL GUIDANCE FOR SEARCH & FORM INPUTS (e.g. YouTube, Google, etc.):
- When the user asks to search for something, find a video/song/topic, or look up information (e.g. "search Indias got latent and play most viewed video", "search 'Khat' and play first video", "search for ..."):
  1. ALWAYS use action type "type" targeting the search input box (look for elements with placeholder/label "Search", id="search", name="search_query", or role="combobox" / type="text" at the top of the page).
  2. DO NOT emit action type "click" on the search input box before typing. The browser client automatically focuses, types, and submits the search when you return action type "type". Emitting "click" first causes a redundant action and an infinite click loop.
  3. Extract ONLY the clean search query into the "value" field (e.g. for "search Indias got latent and play most viewed video", value is "Indias got latent"; for "search 'Khat' and play first video", value is "Khat").
  4. CRITICAL: NEVER click microphone or voice search buttons (labeled "Search with your voice", "Microphone", or "(Microphone / Voice Search / Audio Record Button)") for text search tasks.
  5. Multi-Step Search & Video/Result Navigation:
     - Step 1 (Search bar is empty or user is on home/start page): Emit action type "type" with the search query targeting the search input.
     - Step 2 (Search results page is loaded with video listings/results): Emit action type "click" targeting the requested video title link or first result (look for <a> elements with video titles, e.g. id="video-title" or containing view count info). ALWAYS choose free public videos; DO NOT click videos labeled [MEMBERS ONLY] unless the user explicitly asked for members-only content.
     - Step 3 (Requested video is open and playing without membership gates or blocking prompts): The task is complete! Return action type "done" immediately. If a membership prompt or blocking overlay appears, click another available public video.

VERIFYING TASK COMPLETION IN MULTI-STEP LOOPS (CRITICAL):
- If prior actions or user task context indicate an action was executed (e.g. text typed, button clicked):
  1. Inspect the screen and DOM to verify if the goal has been achieved.
  2. For messaging: If the requested message is visible in the chat history/bubbles, OR the chat input is cleared/empty after sending, THE TASK IS COMPLETE! Return action type "done":
     Example: {{"type": "done", "targetElementId": null, "value": null, "scrollDirection": null}}
  3. If the message text is sitting in the textbox and NOT yet sent (with a Send button visible), return action type "click" targeting the Send button. DO NOT return "done" if the message text is still sitting unsubmitted inside the input field.
  4. For search & video tasks: If the video watch page (/watch) is open or video is playing, THE TASK IS COMPLETE! Return action type "done".
  5. NEVER re-type or re-send the same message if prior actions show it was already executed and delivered. Return "done".

REQUIRED OUTPUT CONTRACT:
You must return ONLY a single valid JSON object strictly matching this schema with NO markdown code block wrapper or extra prose:
{{
  "reasoning": "1-2 sentences, plain language, no chain-of-thought dump",
  "confidence": 0.95,
  "action": {{
    "type": "click",
    "targetElementId": "<exact_elementId_from_list>",
    "value": null,
    "scrollDirection": null
  }},
  "assumptions": ["inferred primary action button based on role and position"],
  "needsClarification": false
}}
(Valid action types: click, type, scroll, select, wait, ask_user, done. For scroll, scrollDirection can be "up" or "down".)
"""

def build_format_param(provider: str, schema: dict) -> dict:
    """
    Envelopes the JSON schema according to provider specifications:
    - Ollama: raw schema dictionary in 'format' (activates llama.cpp grammar-constrained sampling)
    - OpenRouter/OpenAI: 'response_format' with type 'json_schema'
    """
    prov = (provider or "ollama").lower()
    if prov == "ollama":
        return {"format": schema}
    else:
        return {
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "action_response",
                    "strict": True,
                    "schema": schema
                }
            }
        }

def build_request_payload(
    provider: str,
    prompt: str,
    image_b64: str = "",
    schema: dict = None,
    model: str = None,
    stream: bool = False,
    options: dict = None
) -> dict:
    """
    Constructs provider-specific HTTP request body:
    - Ollama: flat {prompt, images: [b64], format: schema, options: {...}}
    - OpenRouter/OpenAI: nested messages with text + image_url blocks and response_format
    """
    prov = (provider or "ollama").lower()
    schema = schema or STRICT_ACTION_SCHEMA
    options = options or {}
    temp = options.get("temperature", 0.2)
    max_tokens = options.get("num_predict", 512)
    resolved_model = model or get_model_for_provider(prov)

    if prov == "ollama":
        payload = {
            "model": resolved_model,
            "prompt": prompt,
            "stream": stream,
            "options": {
                "num_ctx": options.get("num_ctx", 4096),
                "num_predict": max_tokens,
                "temperature": temp,
                "repeat_penalty": options.get("repeat_penalty", 1.15)
            }
        }
        payload.update(build_format_param("ollama", schema))
        if image_b64:
            payload["images"] = [image_b64]
        return payload
    else:
        # OpenRouter / OpenAI chat completions shape
        content = [{"type": "text", "text": prompt}]
        if image_b64:
            url = image_b64 if image_b64.startswith("data:") else f"data:image/png;base64,{image_b64}"
            content.append({
                "type": "image_url",
                "image_url": {"url": url}
            })
        payload = {
            "model": resolved_model,
            "messages": [
                {"role": "user", "content": content}
            ],
            "temperature": temp,
            "max_tokens": max_tokens,
            "stream": stream
        }
        payload.update(build_format_param("openrouter", schema))
        return payload

def call_ollama(prompt: str, image_b64: str, schema: dict = None) -> tuple[str, str]:
    """
    Sends request to Ollama with streaming response support and grammar enforcement.
    """
    model = get_model_for_provider("ollama")
    payload = build_request_payload(
        provider="ollama",
        prompt=prompt,
        image_b64=image_b64,
        schema=schema or STRICT_ACTION_SCHEMA,
        model=model,
        stream=True,
        options={"num_ctx": 4096, "num_predict": 256, "temperature": 0.1, "repeat_penalty": 1.15}
    )

    print(f"[*] Sending request to Ollama ({model}) with strict schema grammar...")
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
    if not full_response and full_thinking:
        full_response = full_thinking
    elif full_response and full_thinking:
        try:
            json.loads(extract_json_block(full_response))
        except Exception:
            try:
                json.loads(extract_json_block(full_thinking))
                full_response = full_thinking
            except Exception:
                pass
    return full_response.strip(), full_thinking.strip()

def call_openrouter(prompt: str, image_b64: str, schema: dict = None, max_network_retries: int = 2) -> tuple[str, str]:
    """
    Sends request to OpenRouter API with network-level exponential backoff
    for transient errors (429 rate limits, 502/503/504 gateways, timeouts).
    """
    api_key = get_openrouter_api_key()
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY is not set. Please set OPENROUTER_API_KEY in server_side_agent/.env or as an environment variable.")

    model = get_model_for_provider("openrouter")
    payload = build_request_payload(
        provider="openrouter",
        prompt=prompt,
        image_b64=image_b64,
        schema=schema or STRICT_ACTION_SCHEMA,
        model=model,
        stream=False,
        options={"num_predict": 200, "temperature": 0.2}
    )

    headers = {
        "Authorization": f"Bearer {api_key}",
        "HTTP-Referer": "https://privamon.local",
        "X-Title": "Privamon Reasoning Agent",
        "Content-Type": "application/json"
    }

    for attempt in range(max_network_retries + 1):
        try:
            print(f"[*] Sending request to OpenRouter ({model}) [Attempt {attempt + 1}/{max_network_retries + 1}]...")
            resp = requests.post(OPENROUTER_URL, json=payload, headers=headers, timeout=120)

            # Handle rate limiting (429) or transient gateway errors (502, 503, 504)
            if resp.status_code in (429, 502, 503, 504) and attempt < max_network_retries:
                wait_time = 1.5 * (2 ** attempt)
                print(f"[!] OpenRouter HTTP {resp.status_code} received. Backing off for {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            if resp.status_code != 200:
                raise Exception(f"OpenRouter API error {resp.status_code}: {resp.text[:300]}")

            data = resp.json()
            choice = data.get("choices", [{}])[0]
            message = choice.get("message", {})
            content = message.get("content", "")
            thinking = message.get("reasoning", "") or ""
            return content.strip(), thinking.strip()

        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as net_err:
            if attempt < max_network_retries:
                wait_time = 1.5 * (2 ** attempt)
                print(f"[!] OpenRouter network error ({net_err}). Retrying in {wait_time:.1f}s...")
                time.sleep(wait_time)
            else:
                raise Exception(f"OpenRouter connection failed after {max_network_retries + 1} attempts: {net_err}")

def call_vlm(prompt: str, image_b64: str, provider: str = None, schema: dict = None) -> tuple[str, str, str]:
    """
    Dispatches to the active VLM provider (Ollama for local testing, OpenRouter for cloud).
    Returns (raw_output, thinking, provider_used).
    Both providers are 100% drop-in replacements with automatic failover if the primary provider
    fails (e.g. OpenRouter 402/401/network or Ollama not running).
    """
    _load_env_file()
    primary = (provider or get_vlm_provider()).lower()
    auto_failover = os.getenv("ENABLE_AUTO_FAILOVER", "true").lower() in ("1", "true", "yes")

    if primary == "openrouter":
        try:
            raw, thinking = call_openrouter(prompt, image_b64, schema=schema)
            return raw, thinking, "openrouter"
        except Exception as e:
            if auto_failover:
                print(f"[!] Primary provider 'openrouter' failed: {e}. Automatically failing over to local Ollama...")
                try:
                    raw, thinking = call_ollama(prompt, image_b64, schema=schema)
                    return raw, thinking, "ollama"
                except Exception as ollama_err:
                    raise Exception(f"OpenRouter ({e}) and Ollama failover ({ollama_err}) both failed.")
            raise
    else:
        try:
            raw, thinking = call_ollama(prompt, image_b64, schema=schema)
            return raw, thinking, "ollama"
        except Exception as e:
            api_key = get_openrouter_api_key()
            if auto_failover and api_key:
                print(f"[!] Primary provider 'ollama' failed: {e}. Automatically failing over to OpenRouter...")
                try:
                    raw, thinking = call_openrouter(prompt, image_b64, schema=schema)
                    return raw, thinking, "openrouter"
                except Exception as or_err:
                    raise Exception(f"Ollama ({e}) and OpenRouter failover ({or_err}) both failed.")
            raise

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

def extract_search_query(task: str) -> Optional[str]:
    """
    Extracts the clean search query term from user tasks like:
    - 'search Indias got latent and play most viewed video' -> 'Indias got latent'
    - 'search "Khat" and play first video that appears' -> 'Khat'
    - 'On this site search "Khat" and play first video that appears' -> 'Khat'
    - 'search lo fi songs on youtube' -> 'lo fi songs'
    """
    if not task:
        return None
    cleaned = re.sub(r"^(?:on this (?:site|page|tab)\s*,?\s*|please\s*)", "", task.strip(), flags=re.I)

    # 1. Quoted query
    m = re.search(r'(?:search(?:\s+for)?|look\s*up|find)\s+["\'\u201c\u201d]([^"\'\u201c\u201d]+)["\'\u201c\u201d]', cleaned, re.I)
    if m:
        return m.group(1).strip()
    # 2. Compound task with "and play/watch/click/open/select"
    m = re.search(r'(?:search(?:\s+for)?|look\s*up|find)\s+(.+?)\s+and\s+(?:play|watch|click|open|select)', cleaned, re.I)
    if m:
        return m.group(1).strip()
    # 3. Simple search with trailing platform mention
    m = re.search(r'(?:search(?:\s+for)?|look\s*up|find)\s+(.+?)(?:\s+(?:on|in)\s+(?:youtube|google|site|page|web))?$', cleaned, re.I)
    if m:
        q = m.group(1).strip()
        q = re.sub(r'\s+(?:on|in)\s+(?:youtube|google|site|page|web)$', '', q, flags=re.I)
        return q.strip()
    return None

def _normalize_search_action(resp: InterpretResponse, task: str, sanitized_dom: Union[list, str, None]) -> InterpretResponse:
    """
    Ensures that if the user's task is a search task and the model returned 'click' on a search input,
    the action is seamlessly normalized to 'type' with the clean extracted query.
    """
    if not resp or not resp.action or resp.action.type != "click" or not resp.action.targetElementId:
        return resp

    has_search_intent = bool(re.search(r'\b(search|find|look\s*up)\b', task, re.I))
    if not has_search_intent:
        return resp

    query = extract_search_query(task)
    if not query:
        return resp

    is_search_bar = False
    reasoning_lower = (resp.reasoning or "").lower()
    if "search" in reasoning_lower and any(w in reasoning_lower for w in ("bar", "input", "box", "enter", "query")):
        is_search_bar = True
    elif isinstance(sanitized_dom, list):
        for el in sanitized_dom:
            el_id = el.get("elementId") or el.get("id")
            if el_id == resp.action.targetElementId:
                tag = (el.get("tag") or "").lower()
                role = (el.get("role") or "").lower()
                attrs = el.get("attributes") or {}
                ph = (el.get("placeholder") or attrs.get("placeholder") or "").lower()
                name = (el.get("name") or "").lower()
                elem_id_str = str(el.get("id") or "").lower()
                if tag in ("input", "textarea") or role in ("combobox", "searchbox", "textbox") or "search" in ph or "search" in name or elem_id_str == "search":
                    is_search_bar = True
                break

    if is_search_bar:
        print(f"[*] Auto-normalizing search action: converted 'click' on search bar {resp.action.targetElementId} to 'type' with query '{query}'")
        resp.action.type = "type"
        resp.action.value = query
        resp.reasoning = f"Entering search query '{query}' into search bar and submitting."
        resp.confidence = max(resp.confidence, 0.95)

    return resp

def extract_message_text(task: str) -> Optional[str]:
    """
    Extracts the message body from tasks like:
    - 'send message to this chat saying Hello' -> 'Hello'
    - 'send message saying "How are you?" to John' -> 'How are you?'
    - 'type Hello in the chat' -> 'Hello'
    - 'say Hi there and press enter' -> 'Hi there'
    """
    if not task:
        return None

    # 1. Quoted string: "Hello" or 'Hello'
    m = re.search(r'["\']([^"\']+)["\']', task)
    if m:
        return m.group(1).strip()

    # 2. "saying <text>"
    m = re.search(r'\bsaying\s+(.+)$', task, re.I)
    if m:
        val = m.group(1).strip()
        val = re.sub(r'\s+and\s+(?:send|press|hit).*$', '', val, flags=re.I)
        return val.strip()

    # 3. "say <text>" or "type <text>" or "write <text>"
    m = re.search(r'\b(?:say|type|write)\s+(.+?)(?:\s+(?:in|into|to|on)\s+.*)?$', task, re.I)
    if m:
        val = m.group(1).strip()
        val = re.sub(r'\s+and\s+(?:send|press|hit).*$', '', val, flags=re.I)
        return val.strip()

    return None

def _normalize_action(resp: InterpretResponse, task: str, sanitized_dom: Union[list, str, None]) -> InterpretResponse:
    """
    Normalizes and fixes model actions for search, chat/messaging, and clicks with text values.
    """
    if not resp or not resp.action:
        return resp

    # 1. Normalize search tasks
    _normalize_search_action(resp, task, sanitized_dom)

    # 2. If action has type='click' but non-empty value, model intended to type
    if resp.action.type == "click" and resp.action.value:
        print(f"[*] Auto-normalizing action: converted 'click' with value '{resp.action.value}' to 'type'")
        resp.action.type = "type"

    # 3. Chat/Messaging: if task is to send message and model clicked the textbox, convert to type
    chat_intent = bool(re.search(r'\b(send|type|write|message|say|chat)\b', task, re.I))
    if chat_intent and resp.action.targetElementId:
        is_textbox = False
        if isinstance(sanitized_dom, list):
            for el in sanitized_dom:
                el_id = el.get("elementId") or el.get("id")
                if el_id == resp.action.targetElementId:
                    tag = (el.get("tag") or "").lower()
                    role = (el.get("role") or "").lower()
                    attrs = el.get("attributes") or {}
                    ph = (el.get("placeholder") or attrs.get("placeholder") or "").lower()
                    if role == "textbox" or tag in ("textarea", "input") or "message" in ph or "type" in ph:
                        is_textbox = True
                    break
        if is_textbox:
            extracted = extract_message_text(task)
            if extracted and (not resp.action.value or resp.action.type == "click"):
                resp.action.value = extracted
            if resp.action.type == "click":
                resp.action.type = "type"
                print(f"[*] Auto-normalizing chat action: converted 'click' on chat textbox to 'type' with value '{resp.action.value}'")

    return resp

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
    _load_env_file()
    start_time = time.perf_counter()
    max_dim = int(os.getenv("VLM_IMAGE_MAX_DIMENSION", "512"))
    optimized_image = optimize_image_b64(image_b64, max_dimension=max_dim) if image_b64 else ""

    prompt = build_reasoning_prompt(
        task=task,
        sanitized_dom=sanitized_dom,
        detection_summary=detection_summary,
        prior_actions=prior_actions,
        conversation_state=conversation_state
    )

    # First attempt via active provider (Ollama / OpenRouter with automatic failover)
    raw_output, thinking, provider_used = call_vlm(prompt, optimized_image)
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
        validated.provider = provider_used
        validated.model = get_model_for_provider(provider_used)
        validated.raw_model_output = raw_output or thinking
        validated.thinking = thinking
        _normalize_action(validated, task, sanitized_dom)
        _populate_backward_compat(validated)
        return validated, latency, False

    # Internal Retry with explicit corrective feedback (DO NOT resend image to avoid CPU ViT latency)
    print(f"\n[!] Model output rejected: {error}. Triggering fast internal retry with strict schema enforcement...")
    retry_prompt = (
        f"{prompt}\n\n"
        f"CRITICAL ERROR: Your previous response failed schema validation: {error}\n"
        f"Fix the error and output ONLY a valid JSON object matching the exact schema:\n"
        f'{{"action": {{"type": "click", "targetElementId": "exact_element_id_or_null", "value": null, "scrollDirection": null}}, "confidence": 0.85, "assumptions": [], "needsClarification": false, "reasoning": "1-2 sentences"}}\n'
    )

    raw_retry, thinking_retry, provider_used_retry = call_vlm(retry_prompt, image_b64="", provider=provider_used)
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
        validated_retry.provider = provider_used_retry
        validated_retry.model = get_model_for_provider(provider_used_retry)
        validated_retry.raw_model_output = raw_retry or thinking_retry
        validated_retry.thinking = thinking_retry or thinking
        _normalize_action(validated_retry, task, sanitized_dom)
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
        thinking=thinking_retry or thinking,
        provider=provider_used,
        model=get_model_for_provider(provider_used)
    )
    _populate_backward_compat(fallback)
    return fallback, latency, True