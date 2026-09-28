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
                    "enum": [
                        "click", "type", "scroll", "select", "wait", "ask_user", "done",
                        "type_and_select", "pick_date", "select_custom", "fill_form"
                    ]
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

    limit = max_elements if max_elements is not None else int(os.getenv("VLM_DOM_MAX_ELEMENTS", "35"))
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
        val_content = el.get("value") or attrs.get("value")
        val = f" value=\"{str(val_content)[:50]}\"" if val_content else ""
        
        type_content = el.get("inputType") or attrs.get("type")
        inp_type = f" type=\"{type_content}\"" if type_content else ""
        
        href_content = el.get("href") or attrs.get("href")
        href = f" href=\"{str(href_content)[:60]}\"" if href_content else ""
        
        options = el.get("options")
        opt_str = ""
        if options and isinstance(options, list):
            opt_labels = [f"{o.get('text', '')}" if isinstance(o, dict) else str(o) for o in options[:8]]
            opt_str = f" options=[{', '.join(opt_labels)}]"

        lines.append(f"- elementId: \"{el_id}\"{pos} | <{tag}{inp_type}{role}{label}{ph}{val}{href}{opt_str}>{text}</{tag}>")

    return "\n".join(lines)

def clean_task_text(task: str) -> str:
    """Strips runtime step guidance and bracketed prompt annotations from task text."""
    if not task:
        return ""
    t = re.sub(r"\[(?:STEP GUIDANCE|VERIFY TASK COMPLETION|outcome|pos|REDACTED)[^\]]*\]", "", task, flags=re.DOTALL | re.I)
    t = re.sub(r"\[.*?\]", "", t, flags=re.DOTALL)
    return t.strip()

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

    clean_user_task = clean_task_text(task)
    m_guide = re.search(r'\[(?:STEP GUIDANCE|VERIFY TASK COMPLETION):(.*?)\]', task, re.DOTALL | re.I)
    guide_section = f"\nVERIFICATION & STEP GUIDANCE:\n{m_guide.group(1).strip()}\n" if m_guide else ""

    return f"""You are the server-side reasoning agent for Privamon. You receive a sanitized, redacted screen context (image + DOM) from a browser extension that has already stripped all PII locally. You do not receive raw pixels, passwords, or personal data — some regions of the image are solid black, and some DOM text is replaced with tokens like [REDACTED: email]. Your job is to understand the user's task, reason about the sanitized screen state, and return a structured, executable action for the browser client to carry out. You never see anything the client didn't choose to send you, so you must reason well despite missing information, not pretend it isn't missing.

USER TASK:
"{clean_user_task}"
{guide_section}
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

SPECIAL GUIDANCE FOR CHAT & MESSAGING: (e.g. WhatsApp, Slack, Messenger)
- Multi-Step Contact Search & Message Flow (e.g. "message Tanishq I will not be available", "search for contact Tanishq and message him...", "send 'Tanishq' a 10 line poem"):
  * Step 1 (Search for contact): Type the contact name into the left contact search bar (look for placeholder "Search or start new chat", "Search", id="search", or role="textbox" on top-left at x < 400, y < 150). DO NOT type into the bottom message textbox on the right!
  * Step 2 (Select contact from search list): In the search results under "Chats" on the left (x < 450, 65 <= y <= 400), click the FIRST/TOP contact result card that matches the contact name. DO NOT click the message textbox on the right yet.
  * Step 3 (Open conversation pane): Once the contact's chat is open, identify the bottom message input box (placeholder "Type a message", role="textbox", contenteditable at bottom y > 500). Emit action type "type" targeting that elementId with the message content in "value". The browser client automatically types and sends the message.
  * Step 4 (Task Complete): If the message has been sent or is visible in chat history, return action type "done".

- Generative vs. Literal Messaging Rules:
  * GENERATIVE / DRAFTING REQUESTS: If the user asks to compose, draft, or generate creative content, greetings, or wishes (e.g. "send 'Shivam' greeting message for his marriage", "send 'Tanishq' a beautiful 10 line poem", "wish Rahul happy birthday", "draft wedding wishes for Priya", "compose a formal apology", "congratulate him on his promotion"), you MUST draft and compose the FULL, warm, personalized message yourself and put it into action.value! (e.g. For marriage greetings: "Congratulations on your wedding, Shivam! Wishing you and your partner a lifetime of love, joy, and endless happiness together!"). NEVER send placeholder text, short summaries, or the literal task instruction words (e.g. NEVER send "greeting message for his marriage" or "wedding wishes").
  * LITERAL REQUESTS: If the user gives an exact or specific message (e.g. "message Tanishq I will not be available for tomorrow", "say hello", "tell him meeting is cancelled"), send ONLY that exact message in action.value without adding poems, greetings, or creative embellishments.

- CRITICAL: NEVER target a microphone or voice recording button (labeled "Voice message", "Microphone", "PTT", or "(Microphone / Voice Record Button - NOT A TEXTBOX)") for text tasks or "type" actions. Always target the actual TEXTBOX (labeled "Type a message", role="textbox", contenteditable).

SPECIAL GUIDANCE FOR SEARCH & FORM INPUTS: (e.g. Flipkart, YouTube, Amazon, Google)
- When the user asks to search for something, find a product/video/song/topic, or look up information (e.g. "search stylish watches for me", "search watches on flipkart", "search Indias got latent and play most viewed video", "search 'Khat' and play first video"):
  1. ALWAYS use action type "type" targeting the search input box (look for elements with placeholder/label "Search", id="search", name="search_query", or tag="input" / role="combobox" / type="text" at the top of the page).
  2. CRITICAL: NEVER emit action type "click" on a search button (Search Icon, magnifying glass button, submit button) when starting a search or when the search input is empty! The search button does NOTHING if the query is not in the search box.
  3. DO NOT emit action type "click" on the search input box before typing. The browser client automatically focuses, types, and submits the search when you return action type "type".
  4. Extract ONLY the clean search query into the "value" field (e.g. for "search stylish watches for me", value is "stylish watches"; for "search watches on flipkart", value is "watches"; for "search 'Khat' and play first video", value is "Khat").
  5. CRITICAL: NEVER click microphone or voice search buttons (labeled "Search with your voice", "Microphone", or "(Microphone / Voice Search / Audio Record Button)") for text search tasks.
  6. Multi-Step Search & Video/Result Navigation:
     - Step 1 (Search bar is empty or user is on home/start page): Emit action type "type" with the search query targeting the search input textbox. NEVER emit action type "done" on the homepage!
     - Step 2 (Search results page is loaded with video listings or product listings):
       * If the user ONLY asked to search (e.g. "search stylish watches for me"), THE SEARCH IS COMPLETE! Return action type "done".
       * If the user asked to play a video or click/open an item, emit action type "click" targeting the requested video title link or product card (look for <a> elements with video titles, e.g. id="video-title"). ALWAYS choose free public videos; DO NOT click videos labeled [MEMBERS ONLY].
     - Step 3 (Requested video is open and playing without membership gates or blocking prompts): The task is complete! Return action type "done" immediately.

VERIFYING TASK COMPLETION IN MULTI-STEP LOOPS (CRITICAL):
- If prior actions or user task context indicate an action was executed (e.g. text typed, button clicked):
  1. Inspect the screen and DOM to verify if the goal has been achieved.
  2. For messaging: If the requested message is visible in the chat history/bubbles, OR the chat input is cleared/empty after sending, THE TASK IS COMPLETE! Return action type "done":
     Example: {{"type": "done", "targetElementId": null, "value": null, "scrollDirection": null}}
  3. If the message text is sitting in the textbox and NOT yet sent (with a Send button visible), return action type "click" targeting the Send button. DO NOT return "done" if the message text is still sitting unsubmitted inside the input field.
  4. For search tasks: NEVER ret
  urn action type "done" on the homepage or when the search input is still empty! Homepage banners, carousels, or suggested items are NOT search results. You may only return "done" once the search results page (/search, /results, /s) is actually loaded with results for the user's specific query.
  5. For video playback tasks: DO NOT return "done" on search results pages when the user asked to play a video! On search results, emit action type "click" targeting the requested/first video title link. Only return action type "done" once the video watch page (/watch) is open and playing.
  6. NEVER re-type or re-send the same message if prior actions show it was already executed and delivered. Return "done".

YOUTUBE-SPECIFIC GUIDANCE (CRITICAL FOR DEMO):
- On YouTube search results, the top results may be videos, playlists (e.g. "Stanford CS229: Machine Learning • Playlist • 21 videos"), or courses (e.g. "Gate Smashers • Course • 55 lessons").
- When asked to play a video or playlist, ALWAYS target the FIRST result card in the main search results section (look for elementId="video-title" or the top card with x >= 240). Never click sidebar navigation links (e.g. "Playlists", "Liked videos", or "History" on the left navigation guide).
- A video or playlist is "playing" ONLY when the page URL contains "/watch?v=" or a playlist player is loaded. If the URL still contains "/results" you are on the search results page, NOT watching/playing the media.
- When clicking a video or playlist title on YouTube, use action type "click" with the exact elementId of the title link. The browser extension will handle SPA navigation.
- If multiple video-title or playlist elements exist, prefer the FIRST one that is NOT labeled [MEMBERS ONLY].

SPECIAL GUIDANCE FOR DROPDOWN / SELECT ELEMENTS:
- When asked to select or choose an option from a dropdown (e.g. "select fourth semester from dropdown", "select semester 4", "choose option"):
  1. Look for elements with tag="select", type="select", or label/id matching the field (e.g. label="Semester").
  2. ALWAYS use action type "select" targeting that elementId.
  3. In the "value" field, provide the option value or text (e.g. "4th Semester", "fourth semester", or "4").
  4. DO NOT use action type "click" or "type" when interacting with a native <select> dropdown. Use action type "select".

SPECIAL GUIDANCE FOR IRCTC & COMPLEX TRAVEL/FORM WORKFLOWS:
- When booking tickets or searching trains/flights (e.g. on IRCTC, MakeMyTrip, RedBus, airlines):
  1. MISSING TRAVEL DETAILS & PREMATURE SEARCH (CRITICAL RULE):
     - If the user says "book ticket", "search trains", or similar without specifying origin, destination, date, or class, DO NOT GUESS OR HALLUCINATE!
     - CRITICAL: NEVER emit action type "click" on the "Search Trains" or search submit button when the From or To inputs are empty! IRCTC will fail with "Error! Please submit correct input". Clicking Search before stations are filled is STRICTLY FORBIDDEN.
     - Instead, emit action type "ask_user" (or "wait" with needsClarification: true) requesting the needed fields:
     Example:
     {{
       "reasoning": "Please fill in your From Station, To Station, and Journey Date directly on the page before searching trains. Use 'Show Me Where' to highlight them, then click Continue once filled.",
       "confidence": 0.95,
       "action": {{
         "type": "ask_user",
         "targetElementId": null,
         "value": "{{\"title\": \"Enter Journey Details on IRCTC\", \"question\": \"Please fill in your travel stations and date directly on the page before proceeding:\", \"fields\": [{{\"name\": \"from\", \"label\": \"From Station\", \"description\": \"Enter departure station (e.g. NDLS / New Delhi)\"}}, {{\"name\": \"to\", \"label\": \"To Station\", \"description\": \"Enter destination station (e.g. BCT / Mumbai Central)\"}}, {{\"name\": \"date\", \"label\": \"Journey Date\", \"description\": \"Select your travel date\"}}, {{\"name\": \"class\", \"label\": \"Class / Quota\", \"description\": \"Choose your coach class\"}}]}}",
         "scrollDirection": null
       }},
       "assumptions": ["user needs to specify origin, destination, and journey date before searching trains"],
       "needsClarification": true
     }}
     The extension client guides the user step-by-step on what to fill directly on the page with interactive field highlights.
  2. AUTOCOMPLETE STATIONS: When filling station fields (e.g. From/To station on IRCTC which use p-autocomplete), use action type "type_and_select" (or "type") with the station code or name in "value" (e.g. "NDLS" or "New Delhi").
  3. DATE PICKERS: When filling date fields (e.g. Journey Date on IRCTC which uses p-calendar), use action type "pick_date" (or "type") with the formatted date (e.g. "DD/MM/YYYY" or "YYYY-MM-DD") in "value".
  4. CLASS / QUOTA SELECTION: When selecting class or quota (which use PrimeNG p-dropdown), use action type "select_custom" (or "select") with the class name in "value".
  5. SUBMIT SEARCH: ONLY once From, To, and Date fields are filled, emit action type "click" targeting the "Search" / "Find Trains" / "Search Trains" button.

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
(Valid action types: click, type, scroll, select, wait, ask_user, done, type_and_select, pick_date, select_custom, fill_form. For scroll, scrollDirection can be "up" or "down".)
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
    max_tokens = options.get("num_predict", int(os.getenv("VLM_MAX_TOKENS", "1024")))
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

def extract_json_block(text: str) -> str:
    """
    Strips markdown formatting and extracts JSON object substring from text.
    """
    if not text:
        return ""
    clean = text.strip()
    if "```" in clean:
        clean = re.sub(r"^```(?:json)?\s*", "", clean, flags=re.MULTILINE)
        clean = re.sub(r"\s*```$", "", clean, flags=re.MULTILINE)

    match = re.search(r"\{.*\}", clean, re.DOTALL)
    if match:
        clean = match.group(0)
    return clean

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
        options={"num_ctx": 4096, "num_predict": int(os.getenv("VLM_MAX_TOKENS", "1024")), "temperature": 0.1, "repeat_penalty": 1.15}
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
        options={"num_predict": int(os.getenv("VLM_MAX_TOKENS", "1024")), "temperature": 0.2}
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

    clean = extract_json_block(raw_text)

    try:
        data = json.loads(clean)
    except Exception as e:
        return None, f"JSON parse error: {e}"

    if not isinstance(data, dict):
        return None, "Root JSON must be an object"

    VALID_ACTION_TYPES = ("click", "type", "scroll", "select", "wait", "ask_user", "done", "type_and_select", "pick_date", "select_custom", "fill_form")

    # Normalize legacy {"actions": [...]} if model slipped into older output format
    if "actions" in data and isinstance(data["actions"], list) and data["actions"]:
        first = data["actions"][0]
        act_type = str(first.get("type", "click")).lower()
        if act_type not in VALID_ACTION_TYPES:
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
        if raw_type not in VALID_ACTION_TYPES:
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
        if raw_type in VALID_ACTION_TYPES:
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
        if raw_type not in VALID_ACTION_TYPES:
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

INVALID_CONTACT_NAMES = {
    "this chat", "chat which is open", "the chat", "chat", "someone", "him", "her", "them",
    "this", "open chat", "active chat", "user", "message", "a message", "the message", "poem", "song",
    "story", "lines", "line", "love", "photo", "image", "video", "text", "a text", "the text", "audio", "note",
    "somethin", "something", "everything", "anything", "that", "it", "its", "me", "you", "us", "he", "she", "they",
    "a", "an", "the", "to", "for", "saying", "with", "about", "what", "which", "who", "whom", "whose", "where", "when", "why", "how", "all", "any", "some"
}

def is_valid_contact_name(name: Optional[str]) -> bool:
    if not name:
        return False
    clean = name.strip("\"'“” ").strip()
    if not clean or clean.isdigit() or re.match(r"^\d+$", clean):
        return False
    if clean.lower() in INVALID_CONTACT_NAMES:
        return False
    if re.match(r"^\d+(?:st|nd|rd|th)?$", clean, re.I):
        return False
    return True

def parse_contact_task(task: str) -> tuple[Optional[str], Optional[str]]:
    """
    Extracts contact name and message body/intent from tasks like:
    - 'message Tanishq I will be not availablle for tommorow' -> ('Tanishq', 'I will be not availablle for tommorow')
    - 'search for contact Tanishq and message him that I will not be avilable' -> ('Tanishq', 'I will not be avilable')
    - 'send "Tanishq" a beatifull 10 line poem' -> ('Tanishq', 'beatifull 10 line poem')
    - 'tell Parth Bhaiya that meeting is cancelled' -> ('Parth Bhaiya', 'meeting is cancelled')
    - 'send "shivam" greeting message for his marriage' -> ('shivam', 'greeting message for his marriage')
    - 'send "shivam" message that I will not able to attend his lecture tommorow be polite' -> ('shivam', 'I will not able to attend his lecture tommorow be polite')
    """
    if not task:
        return None, None
    cleaned = clean_task_text(task)

    # 1. "search (for contact) <contact> and message/tell/send/text him/her (that/saying) <msg>"
    m = re.search(r"\b(?:search\s+(?:for\s+)?(?:contact\s+)?|find\s+)(.+?)\s+and\s+(?:message|tell|send|text)(?:\s+(?:him|her|them))?(?:\s+(?:that|saying))?\s+(.+)$", cleaned, re.I)
    if m:
        c = m.group(1).strip("\"'“” ")
        if is_valid_contact_name(c):
            return c, m.group(2).strip()

    # 2. "send message to <contact> saying/that <msg>"
    m = re.search(r"\bsend\s+(?:a\s+)?message\s+to\s+(.+?)\s+(?:saying|that)\s+(.+)$", cleaned, re.I)
    if m:
        c = m.group(1).strip("\"'“” ")
        if is_valid_contact_name(c):
            return c, m.group(2).strip()

    # 3. Quoted contact: send/message/text "<contact>" [message that/saying/a] <msg>
    m = re.search(r'\b(?:send|message|tell|text)\s+["\'\u201c\u201d]([^"\'\u201c\u201d]+)["\'\u201c\u201d]\s*(?:(?:a\s+)?(?:message|text|note|greeting|wish|chat)?\s*(?:that\s+|saying\s+|say\s+|to\s+)|a\s+|that\s+|saying\s+)?\s*(.+)$', cleaned, re.I)
    if m:
        c = m.group(1).strip()
        if is_valid_contact_name(c):
            return c, m.group(2).strip()

    # 4. Two-word capitalized contact name: e.g. "Parth Bhaiya"
    m = re.search(r"\b(?:message|tell|text|send)\s+([A-Z][a-z0-9_]+\s+[A-Z][a-z0-9_]+)\s+(?:a\s+|that\s+|saying\s+)?(.+)$", cleaned)
    if m:
        c = m.group(1).strip()
        if is_valid_contact_name(c):
            return c, m.group(2).strip()

    # 5. Single word contact followed by "a" / "an" / "that" / "saying":
    m = re.search(r"\b(?:send|message|tell|text)\s+([A-Za-z0-9_]+)\s+(?:a|an|that|saying)\s+(.+)$", cleaned, re.I)
    if m:
        c = m.group(1).strip()
        if is_valid_contact_name(c):
            return c, m.group(2).strip()

    # 6. Single word contact followed by message starting with pronoun or verb:
    m = re.search(r"\b(?:send|message|tell|text)\s+([A-Za-z0-9_]+)\s+(?=(?:I|we|you|he|she|they|please|call|meeting|let|can|will|dont|am|are|is|hello|hi|hey)\b)(.+)$", cleaned, re.I)
    if m:
        c = m.group(1).strip()
        if is_valid_contact_name(c):
            return c, m.group(2).strip()

    # 7. Fallback: message/text <contact> <msg>
    m = re.search(r"\b(?:send|message|tell|text)\s+([A-Za-z0-9_]+)\s+(.+)$", cleaned, re.I)
    if m:
        c = m.group(1).strip()
        if is_valid_contact_name(c):
            return c, m.group(2).strip()

    return None, None

def is_creative_generation_task(task: str) -> bool:
    """
    Detects if the user asked for generative/creative content or message drafting like:
    - 'send "shivam" greeting message for his marriage'
    - 'send "shivam" message that I will not able to attend his lecture tommorow be polite'
    - 'send "Tanishq" a beatifull 10 line poem'
    - 'send shivam wedding wishes'
    - 'wish rahul happy birthday'
    - 'draft wedding message for priya'
    - 'write a 5 line poem and send to Parth'
    - '10 line poem on love'
    - 'message him a love song of 10 lines'
    - 'a love story about king and queen'
    - 'generate a formal apology note'
    - 'compose a congratulatory message'
    - 'type atleast 10 lines of poetry'
    """
    if not task:
        return False
    return bool(re.search(
        r"\b("
        r"poem|poetry|rhyme|story|essay|haiku|compliment|joke|apology|apologize|speech|"
        r"song|lyrics|letter|compose\w*|generate\w*|"
        r"greeting\w*|wish\w*|blessing\w*|congratulat\w*|"
        r"marriage|wedding|anniversary|birthday|promotion|festival|"
        r"lines?\s+of|lines?\s+on|\d+\s+line|"
        r"message\s+(?:about|for|wishing|congratulating|that|saying)|"
        r"tell\s+(?:\w+\s+)?(?:that|saying)|"
        r"write\s+(?:a\s+)?(?:message|note|greeting|wish)|"
        r"draft\w*\s+(?:a\s+)?(?:\w+\s+)?(?:poem|song|story|greeting|wish|speech|lyrics|essay|message|note)|"
        r"be\s+polite|politely|formal\w*|courteous\w*|sorry|emotion\w*|excuse|reason|unable\s+to\s+attend|cannot\s+attend|will\s+not\s+be\s+able"
        r")\b",
        task,
        re.I
    ))

def clean_composed_lines(text: str) -> str:
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if lines and re.match(r"^(?:\d+\s+line|poem|here\s+is|title:|a\s+poem|song)\b", lines[0], re.I):
        lines = lines[1:]
    return "\n".join(lines)

def is_prompt_echo(value: Optional[str], task: str) -> bool:
    if not value or not str(value).strip():
        return True
    v = str(value).strip().lower().strip("\"'“” ")
    t = clean_task_text(task).strip().lower()
    if v == t:
        return True

    # Check against extracted body from parse_contact_task (e.g. 'greeting message for his marriage')
    contact_name, body = parse_contact_task(task)
    if body:
        b = body.strip().lower().strip("\"'“” ")
        if v == b or (b in v and len(v) <= len(b) + 15) or (v in b and len(v) >= 5):
            return True

    t_noprefix = re.sub(r'^(?:send(?:\s+him|\s+her|\s+them)?|message(?:\s+him|\s+her|\s+them)?|type|write|tell(?:\s+him|\s+her)?)\s+', '', t).strip()
    if v == t_noprefix or (t_noprefix in v and len(v) <= len(t_noprefix) + 15):
        return True

    t_nocontact = re.sub(r'^["\'\u201c\u201d][^"\'\u201c\u201d]+["\'\u201c\u201d]\s*(?:a\s+|an\s+|that\s+|saying\s+)?', '', t_noprefix).strip()
    if t_nocontact and (v == t_nocontact or (t_nocontact in v and len(v) <= len(t_nocontact) + 15) or (v in t_nocontact and len(v) >= 5)):
        return True

    if is_creative_generation_task(task):
        if re.search(r'\b(greeting\s+message|wedding\s+wishes?|marriage\s+wishes?|birthday\s+wishes?|anniversary\s+wishes?|poem\s+on|\d+\s+line\s+poem|a\s+love\s+story|congratulatory\s+message)\b', v, re.I):
            return True
        if re.search(r'\b(?:poem|poetry|rhyme|lines?\s+of|\d+\s+line)\b', t, re.I):
            lines = [l for l in str(value).split('\n') if l.strip()]
            if len(lines) < 3:
                return True
        if len(v) < 15:
            return True

    return False

CREATIVE_TEXT_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {
            "type": "string",
            "description": "The complete creative text, poem, story, or message requested by the user."
        }
    },
    "required": ["text"],
    "additionalProperties": False
}

def compose_creative_fallback(task: str) -> str:
    """
    Guarantees a beautiful composed creative poem, wedding/birthday greeting, or message even if model echoed prompt.
    """
    contact_name, body = parse_contact_task(task)
    prompt = (
        f"You are an expert message drafter and courteous assistant.\n"
        f"Draft and write the complete, warm, beautifully written message requested by the user: {task!r}.\n"
        f"If the request asks to be polite, apologize, or excuse oneself (e.g. unable to attend a lecture or meeting), draft a courteous, natural, polite message directly addressed to the recipient.\n"
        f"If the request is for a wedding, marriage, birthday, anniversary, or greeting message, write a heartwarming, joyful greeting message directly addressed to the recipient.\n"
        f"For poems, separate each line with a newline character (\\n).\n"
        f"Do NOT include explanations, titles, or prompt echoes. Output ONLY the drafted message into the 'text' field."
    )
    try:
        raw, _, _ = call_vlm(prompt, "", provider=get_vlm_provider(), schema=CREATIVE_TEXT_SCHEMA)
        text = raw.strip()
        if text.startswith("{"):
            d = json.loads(text)
            if "text" in d and d["text"]:
                text = str(d["text"]).strip()
            elif "action" in d and isinstance(d["action"], dict) and d["action"].get("value"):
                text = str(d["action"]["value"]).strip()
            elif "value" in d:
                text = str(d["value"]).strip()
        if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
            text = text[1:-1].strip()
        cleaned = clean_composed_lines(text)
        if cleaned and len(cleaned) > 20 and not cleaned.startswith("{") and not is_prompt_echo(cleaned, task):
            return cleaned
    except Exception as e:
        print("[!] Warning: Creative fallback composition call failed:", e)

    # Built-in high quality greetings and lyrical poems by theme if offline/network issue
    t_lower = task.lower()
    c_name = contact_name or "my friend"
    if any(k in t_lower for k in ("lecture", "attend", "class", "meeting", "absence", "unavailable", "polite")):
        return (
            f"Dear {c_name}, I wanted to let you know that I will not be able to attend your lecture tomorrow. "
            "Sincerely apologize for any inconvenience caused!"
        )
    if any(k in t_lower for k in ("marriage", "wedding")):
        return (
            f"Heartiest congratulations on your wedding, {c_name}! "
            "Wishing you and your partner a lifetime filled with immense love, joy, and endless happiness together. "
            "May your journey together be blessed with beautiful memories every single day!"
        )
    if any(k in t_lower for k in ("birthday", "bday")):
        return (
            f"Wishing you a very Happy Birthday, {c_name}! "
            "May your day be filled with lots of love, laughter, and wonderful moments. "
            "Have a fantastic year ahead!"
        )
    if "anniversary" in t_lower:
        return (
            f"Happy Anniversary, {c_name}! "
            "Wishing you both another year of wonderful togetherness, love, and cherished moments. "
            "Congratulations!"
        )
    if any(k in t_lower for k in ("congratulat", "promotion", "success")):
        return (
            f"Huge congratulations, {c_name}! "
            "So thrilled to hear this wonderful news. Wishing you continued success and the very best in everything you do!"
        )
    if any(k in t_lower for k in ("greeting", "wish")):
        return (
            f"Warmest greetings and best wishes to you, {c_name}! "
            "Hope you are having a wonderful day and that everything is going great!"
        )
    if "love" in t_lower:
        return (
            "Love is a quiet flame that warms the soul,\n"
            "It whispers through the silence, soft and bold.\n"
            "It blooms in moments when the world feels cold,\n"
            "And turns the darkest nights to golden gold.\n"
            "It's found in laughter, tears, and every glance,\n"
            "In hands that hold, and hearts that dare to dance.\n"
            "It grows with time, though seasons may advance,\n"
            "A constant rhythm in a fleeting trance.\n"
            "It asks for nothing but to give anew,\n"
            "Forever patient, beautiful, and true."
        )
    return (
        "Beneath the sky of sapphire blue,\n"
        "A gentle breeze begins anew.\n"
        "The morning sun begins to rise,\n"
        "Illuminating distant skies.\n"
        "A golden warmth upon the sea,\n"
        "A peaceful moment wild and free.\n"
        "Through whispering trees the shadows play,\n"
        "To welcome in another day.\n"
        "With every breath a song takes flight,\n"
        "From darkest dusk to morning light."
    )

def is_contact_result_item(el: dict, contact_name: Optional[str] = None) -> bool:
    """Checks if a DOM element is a contact search result card in WhatsApp Web."""
    if not isinstance(el, dict):
        return False
    if el.get("isAudioRecord"):
        return False

    tag = (el.get("tag") or "").lower()
    role = (el.get("role") or "").lower()
    attrs = el.get("attributes") or {}
    ph = str(el.get("placeholder") or attrs.get("placeholder") or "").strip().lower()
    lbl = str(el.get("label") or "").strip().lower()
    txt = str(el.get("text") or "").strip().lower()
    eid = str(el.get("elementId") or el.get("id") or "").lower()

    # Reject search input fields and textboxes
    if "search" in ph or "search" in lbl or "search" in eid or role in ("searchbox", "combobox"):
        return False
    if role == "textbox" and (tag in ("input", "textarea") or "search" in ph or "chat" in ph):
        return False

    if lbl in {"all", "unread", "favourites", "groups", "chats", "status", "channels", "communities", "archived", "filter chats by"}:
        return False

    bbox = el.get("bbox") or {}
    x = bbox.get("x")
    y = bbox.get("y")

    # If contact name is known, check if it directly appears in label or text
    if contact_name and len(contact_name) >= 2:
        c_lower = contact_name.lower()
        if c_lower in lbl or c_lower in txt:
            if x is None or x < 500:
                return True

    # Spatial check for left-pane contact search result under "Chats"
    if x is not None and y is not None:
        if x < 450 and 65 <= y <= 450:
            if role in ("listitem", "row", "gridcell") or tag in ("div", "span", "a", "button"):
                return True

    return False

def find_contact_search_input(sanitized_dom: Union[list, str, None]) -> Optional[dict]:
    """Finds the contact search input box on WhatsApp/chat (top-left pane)."""
    if not isinstance(sanitized_dom, list):
        return None
    for el in sanitized_dom:
        if el.get("isAudioRecord"):
            continue
        tag = (el.get("tag") or "").lower()
        role = (el.get("role") or "").lower()
        attrs = el.get("attributes") or {}
        ph = str(el.get("placeholder") or attrs.get("placeholder") or "").lower()
        lbl = str(el.get("label") or "").lower()
        eid = str(el.get("id") or el.get("elementId") or "").lower()
        bbox = el.get("bbox") or {}
        x = bbox.get("x")
        y = bbox.get("y")

        if "search or start new chat" in ph or "search or start new chat" in lbl:
            return el
        if ("search" in ph or "search" in lbl or "search" in eid) and (role in ("textbox", "searchbox", "combobox") or tag in ("input", "textarea", "div")):
            if x is None or (x < 450 and (y is None or y < 200)):
                return el
    return None

def find_chat_message_textbox(sanitized_dom: Union[list, str, None]) -> Optional[dict]:
    """Finds the active chat's message input textbox (typically at the bottom)."""
    if not isinstance(sanitized_dom, list):
        return None
    for el in sanitized_dom:
        if el.get("isAudioRecord"):
            continue
        tag = (el.get("tag") or "").lower()
        role = (el.get("role") or "").lower()
        attrs = el.get("attributes") or {}
        ph = str(el.get("placeholder") or attrs.get("placeholder") or "").lower()
        lbl = str(el.get("label") or "").lower()
        is_contenteditable = bool(el.get("isContentEditable") or el.get("inputType") == "contenteditable" or attrs.get("type") == "contenteditable")

        if "type a message" in ph or "type a message" in lbl:
            return el
        if (role == "textbox" or tag in ("textarea", "input") or is_contenteditable) and ("message" in ph or "message" in lbl or "chat" in ph):
            return el
        bbox = el.get("bbox") or {}
        y = bbox.get("y")
        if (role == "textbox" or is_contenteditable) and (y is not None and y > 450):
            return el
    return None

def extract_search_query(task: str) -> Optional[str]:
    """
    Extracts the clean search query term from user tasks like:
    - 'search stylish watches for me' -> 'stylish watches'
    - 'search Indias got latent and play most viewed video' -> 'Indias got latent'
    - 'search "Khat" and play first video that appears' -> 'Khat'
    - 'On this site search "Khat" and play first video that appears' -> 'Khat'
    - 'search lo fi songs on youtube' -> 'lo fi songs'
    - 'search watches on flipkart' -> 'watches'
    """
    if not task:
        return None
    cleaned = clean_task_text(task)

    # If this is a contact messaging task (e.g. "search for contact Tanishq and message him..."), do not treat as web/product search
    contact_name, _ = parse_contact_task(cleaned)
    if contact_name:
        return None
    cleaned = re.sub(r"^(?:on this (?:site|page|tab)\s*,?\s*|please\s*)", "", cleaned.strip(), flags=re.I)

    # 1. Quoted query: search for "stylish watches" -> stylish watches
    m = re.search(r'(?:search(?:\s+for)?|look\s*up|find)\s+["\'\u201c\u201d]([^"\'\u201c\u201d]+)["\'\u201c\u201d]', cleaned, re.I)
    if m:
        q = m.group(1).strip()
        q = re.sub(r'\s+(?:for\s+me|for\s+us|please)$', '', q, flags=re.I)
        return q.strip()
    # 2. Compound task with "and play/watch/click/open/select"
    m = re.search(r'(?:search(?:\s+for)?|look\s*up|find)\s+(.+?)\s+and\s+(?:play|watch|click|open|select)', cleaned, re.I)
    if m:
        q = m.group(1).strip()
        q = re.sub(r'\s+(?:on|in)\s+(?:youtube|google|flipkart|amazon|myntra|meesho|site|page|web)$', '', q, flags=re.I)
        q = re.sub(r'\s+(?:for\s+me|for\s+us|please)$', '', q, flags=re.I)
        return q.strip()
    # 3. Simple search with trailing platform mention or 'for me': search watches on flipkart -> watches
    m = re.search(r'(?:search(?:\s+for)?|look\s*up|find)\s+(.+?)(?:\s+(?:on|in)\s+(?:youtube|google|flipkart|amazon|myntra|meesho|site|page|web|\w+\.\w+))?$', cleaned, re.I)
    if m:
        q = m.group(1).strip()
        q = re.sub(r'\s+(?:on|in)\s+(?:youtube|google|flipkart|amazon|myntra|meesho|site|page|web|\w+\.\w+)$', '', q, flags=re.I)
        q = re.sub(r'\s+(?:for\s+me|for\s+us|please)$', '', q, flags=re.I)
        return q.strip()
    return None

def find_search_input(sanitized_dom: Union[list, str, None]) -> Optional[dict]:
    """Finds the primary search input/textarea in the sanitized DOM."""
    if not isinstance(sanitized_dom, list):
        return None
    for el in sanitized_dom:
        if el.get("isAudioRecord"):
            continue
        tag = (el.get("tag") or "").lower()
        role = (el.get("role") or "").lower()
        if tag == "button" or role == "button":
            continue
        if tag in ("input", "textarea") or role in ("searchbox", "combobox", "textbox"):
            attrs = el.get("attributes") or {}
            ph = str(el.get("placeholder") or attrs.get("placeholder") or "").lower()
            lbl = str(el.get("label") or "").lower()
            nm = str(el.get("name") or attrs.get("name") or "").lower()
            eid = str(el.get("id") or "").lower()
            if (
                "search" in ph or "search" in lbl or "query" in ph or
                nm in ("q", "search_query") or eid in ("search", "twotabsearchtextbox") or
                "search" in eid
            ):
                return el
    return None

def is_result_item(el: dict) -> bool:
    """Checks if a DOM element is a search result item (video title, playlist card, course, product card link)."""
    tag = (el.get("tag") or "").lower()
    role = (el.get("role") or "").lower()
    attrs = el.get("attributes") or {}
    href = str(el.get("href") or attrs.get("href") or "").lower()
    label = str(el.get("label") or "").lower()
    el_id = str(el.get("elementId") or el.get("id") or "").lower()
    text = str(el.get("text") or "").lower()
    bbox = el.get("bbox") or {}
    x = bbox.get("x") if isinstance(bbox, dict) else None

    # Reject sidebar navigation items (left guide)
    if el.get("isSidebar") or (x is not None and x < 200 and label in {"playlists", "liked videos", "subscriptions", "library", "history", "home", "shorts"}):
        return False

    # YouTube video or playlist result detection
    if el_id == "video-title" or el.get("isSearchResult") or el.get("isPlaylist"):
        return True
    if "/watch" in href or "/playlist" in href or "/course" in href:
        return True
    if "views" in label or "playlist" in label or "course" in label or "lessons" in label:
        return True
    if "view full playlist" in text or "view full course" in text:
        return True
    # Broader YouTube video/playlist card detection: labels with view counts, duration, channel info
    if tag in ("a", "yt-formatted-string") and (
        re.search(r'\d+[KMkm]?\s*views', label) or
        re.search(r'\d+\s*(hours?|minutes?|seconds?)\s*ago', label) or
        re.search(r'\d+:\d+', label) or  # duration like 12:34
        re.search(r'\d+[KMkm]?\s*views', text) or
        re.search(r'\d+\s*(videos|lessons)', label) or
        re.search(r'\d+\s*(videos|lessons)', text)
    ):
        return True
    # E-commerce product result detection
    if tag == "a" and ("/p/" in href or "/dp/" in href or "/product/" in href or "₹" in label or "rs." in label or "$" in label):
        return True
    return False

def is_search_button(el: dict) -> bool:
    """Checks if a DOM element is a search submit button / search icon."""
    tag = (el.get("tag") or "").lower()
    role = (el.get("role") or "").lower()
    attrs = el.get("attributes") or {}
    label = str(el.get("label") or "").lower()
    elem_id = str(el.get("id") or "").lower()
    btn_type = str(el.get("inputType") or attrs.get("type") or "").lower()

    if tag == "button" or role == "button" or btn_type == "submit":
        if "search" in label or "search" in elem_id or "submit" in elem_id or elem_id == "search-icon-legacy":
            return True
        if "search for products" in label or "find" in label:
            return True
    return False

def _normalize_search_action(
    resp: InterpretResponse,
    task: str,
    sanitized_dom: Union[list, str, None],
    prior_actions: list = None
) -> InterpretResponse:
    """
    Ensures search tasks reliably type the clean query into the search input box:
    1. Clicks on video links or product cards are PRESERVED as clicks.
    2. Premature 'done' actions on Step 0 are converted to 'type' with the search query.
    3. Clicks on the search input itself are converted to 'type' with the search query.
    4. Clicks on search buttons when the search input is empty are converted to 'type' on the search input.
    5. 'type' actions accidentally targeting buttons are redirected to the search input.
    6. Respects verified 'done' actions once a search action was executed in prior steps.
    """
    if not resp or not resp.action:
        return resp

    clean_task = clean_task_text(task)
    # Skip if task is contact messaging (e.g. "search for contact Tanishq and message him...")
    contact_name, _ = parse_contact_task(clean_task)
    if contact_name:
        return resp

    has_search_intent = bool(re.search(r'\b(search|find|look\s*up)\b', clean_task, re.I))
    if not has_search_intent:
        return resp

    query = extract_search_query(clean_task)
    if not query:
        return resp

    # Check if a search was already performed in prior actions
    has_prior_search = False
    if prior_actions:
        for act in prior_actions:
            act_str = str(act).lower()
            if "type" in act_str:
                has_prior_search = True
                break

    search_input = find_search_input(sanitized_dom)

    # Locate target element if one was specified
    target_el = None
    if isinstance(sanitized_dom, list) and resp.action.targetElementId:
        for el in sanitized_dom:
            if (el.get("elementId") or el.get("id")) == resp.action.targetElementId:
                target_el = el
                break

    # CRITICAL: If target is explicitly a video link or product result item, PRESERVE IT AS CLICK!
    if target_el and is_result_item(target_el):
        return resp

    if search_input:
        search_input_id = search_input.get("elementId") or search_input.get("id")
        raw_val = search_input.get("value") or (search_input.get("attributes") or {}).get("value")
        current_input_val = str(raw_val or "").strip()
        is_query_in_input = bool(
            query and (
                query.lower() in current_input_val.lower() or
                (current_input_val and current_input_val.lower() in query.lower())
            )
        )

        # Case A: Model returned 'done' on Step 0 (no prior search executed) but search query was never entered!
        if resp.action.type == "done" and not is_query_in_input and not has_prior_search:
            print(f"[*] Auto-normalizing search action: prevented premature 'done' on empty search page; converting to 'type' on {search_input_id} with query '{query}'")
            resp.action.type = "type"
            resp.action.targetElementId = search_input_id
            resp.action.value = query
            resp.reasoning = f"Entering search query '{query}' into search bar and submitting."
            resp.confidence = max(resp.confidence, 0.95)
            return resp

        # Case B: Model returned 'click' on the search input itself
        if resp.action.type == "click" and resp.action.targetElementId == search_input_id:
            print(f"[*] Auto-normalizing search action: converted 'click' on search input {search_input_id} to 'type' with query '{query}'")
            resp.action.type = "type"
            resp.action.value = query
            resp.reasoning = f"Entering search query '{query}' into search bar and submitting."
            resp.confidence = max(resp.confidence, 0.95)
            return resp

        # Case C: Model returned 'click' on a search button/icon when input is empty and no prior search ran
        if resp.action.type == "click" and target_el and is_search_button(target_el) and not is_query_in_input and not has_prior_search:
            print(f"[*] Auto-normalizing search action: converted 'click' on search button {resp.action.targetElementId} with empty input to 'type' on {search_input_id} with query '{query}'")
            resp.action.type = "type"
            resp.action.targetElementId = search_input_id
            resp.action.value = query
            resp.reasoning = f"Entering search query '{query}' into search bar and submitting."
            resp.confidence = max(resp.confidence, 0.95)
            return resp

        # Case D: Model returned 'type' targeting a button instead of the actual input
        if resp.action.type == "type" and target_el and (target_el.get("tag") == "button" or target_el.get("role") == "button"):
            print(f"[*] Auto-normalizing search action: redirecting 'type' from button {resp.action.targetElementId} to input {search_input_id}")
            resp.action.targetElementId = search_input_id
            if not resp.action.value:
                resp.action.value = query
            return resp

        # Case E: Pure search task on Step 0 with empty input
        is_compound_task = bool(re.search(r'\b(play|watch|click|open|select)\b', clean_task, re.I))
        if not is_compound_task and not is_query_in_input and not has_prior_search and resp.action.type != "type":
            print(f"[*] Auto-normalizing search action: pure search task on empty search input; converting to 'type' on {search_input_id} with query '{query}'")
            resp.action.type = "type"
            resp.action.targetElementId = search_input_id
            resp.action.value = query
            resp.reasoning = f"Entering search query '{query}' into search bar and submitting."
            resp.confidence = max(resp.confidence, 0.95)
            return resp

    # Case F: Block premature 'done' on compound search+play tasks when search ran but video isn't playing
    is_video_play_task = bool(re.search(r'\b(play|watch)\b', clean_task, re.I))
    if resp.action.type == "done" and has_prior_search and is_video_play_task:
        # If prior search ran but no click on a result has been done yet, find the first result item
        has_prior_click_on_result = False
        if prior_actions:
            for act in prior_actions:
                act_str = str(act).lower()
                if "click" in act_str and ("video" in act_str or "watch" in act_str or "playlist" in act_str):
                    has_prior_click_on_result = True
                    break
        if not has_prior_click_on_result and isinstance(sanitized_dom, list):
            # Find first result item to click
            for el in sanitized_dom:
                if is_result_item(el):
                    el_id = el.get("elementId") or el.get("id")
                    label = el.get("label") or el.get("text") or "first media item"
                    # Skip members-only videos
                    if "members only" in str(label).lower():
                        continue
                    print(f"[*] Auto-normalizing: blocked premature 'done' on video/playlist play task; converting to 'click' on {el_id}")
                    resp.action.type = "click"
                    resp.action.targetElementId = el_id
                    resp.action.value = None
                    resp.reasoning = f"Clicking first video or playlist result to play it."
                    resp.confidence = max(resp.confidence, 0.90)
                    return resp

    return resp

def extract_message_text(task: str) -> Optional[str]:
    """
    Extracts the message body from tasks like:
    - 'send message to this chat saying Hello' -> 'Hello'
    - 'send message saying "How are you?" to John' -> 'How are you?'
    - 'type Hello in the chat' -> 'Hello'
    - 'say Hi there and press enter' -> 'Hi there'
    - 'message Tanishq I will not be available for tomorrow' -> 'I will not be available for tomorrow'
    """
    if not task:
        return None
    cleaned = clean_task_text(task)

    # If it is a creative generation task (e.g. 10 line poem), let the model compose it
    if is_creative_generation_task(cleaned):
        return None

    # Check contact task parsing first (e.g. "message Tanishq I will not be available")
    contact_name, body = parse_contact_task(cleaned)
    if body and not is_creative_generation_task(body):
        return body

    # 1. Quoted string: "Hello" or 'Hello' (avoid extracting contact name from send "Tanishq" a message)
    m = re.search(r'["\']([^"\']+)["\']', cleaned)
    if m:
        val = m.group(1).strip()
        if not re.search(r'(?:send|message|tell|text)\s+["\']' + re.escape(val) + r'["\']', cleaned, re.I):
            return val

    # 2. "saying <text>"
    m = re.search(r'\bsaying\s+(.+)$', cleaned, re.I)
    if m:
        val = m.group(1).strip()
        val = re.sub(r'\s+and\s+(?:send|press|hit).*$', '', val, flags=re.I)
        return val.strip()

    # 3. "say <text>" or "type <text>" or "write <text>"
    m = re.search(r'\b(?:say|type|write)\s+(.+?)(?:\s+(?:in|into|to|on)\s+.*)?$', cleaned, re.I)
    if m:
        val = m.group(1).strip()
        val = re.sub(r'\s+and\s+(?:send|press|hit).*$', '', val, flags=re.I)
        return val.strip()

    # 4. "message that <text>" or "send him/her message that <text>"
    m = re.search(r'\b(?:send\s+(?:\w+\s+)?message\s+that|message\s+that)\s+(.+)$', cleaned, re.I)
    if m:
        val = m.group(1).strip()
        val = re.sub(r'\s+and\s+(?:send|press|hit).*$', '', val, flags=re.I)
        return val.strip()

    return None

def _normalize_contact_chat_action(
    resp: InterpretResponse,
    task: str,
    sanitized_dom: Union[list, str, None],
    prior_actions: list = None
) -> InterpretResponse:
    """
    Normalizes multi-step contact messaging workflows (e.g. on WhatsApp Web):
    - Step 1: Types contact name into contact search bar.
    - Step 2: Clicks top contact result under Chats on the left.
    - Step 3: Types message or generated poem into message textbox.
    - Step 4: Handles verified completion / 'done'.
    - Preserves generated creative content (poems/rhymes) when is_creative_generation_task is True.
    """
    if not resp or not resp.action:
        return resp

    clean_task = clean_task_text(task)
    contact_name, body = parse_contact_task(clean_task)
    is_creative = is_creative_generation_task(clean_task)

    has_chat_intent = bool(
        contact_name or
        is_creative or
        re.search(r'\b(send|type|write|message|say|chat|tell|text|draft)\b', clean_task, re.I)
    )
    if not has_chat_intent:
        return resp

    # Check prior actions history
    has_prior_search = False
    has_prior_click_contact = False
    has_prior_message_sent = False
    if prior_actions:
        target_words = [
            w.lower() for w in re.findall(r'\b[a-zA-Z]{4,}\b', body or clean_task)
            if w.lower() not in {"send", "message", "that", "with", "from", "about", "this", "will", "please", "polite"}
        ]
        for act in prior_actions:
            act_str = str(act).lower()
            if "click" in act_str:
                if has_prior_search:
                    has_prior_click_contact = True
                elif contact_name and contact_name.lower() in act_str:
                    has_prior_search = True
                    has_prior_click_contact = True
            elif "type" in act_str:
                if contact_name and (f'"{contact_name.lower()}"' in act_str or f"'{contact_name.lower()}'" in act_str or "search" in act_str):
                    has_prior_search = True
                elif "executed" in act_str or "sent" in act_str:
                    if target_words:
                        matches = sum(1 for w in target_words if w in act_str)
                        if matches >= min(2, len(target_words)):
                            has_prior_message_sent = True
                            break
                    elif is_creative and any(k in act_str for k in ("poem", "congratulat", "wedding", "marriage", "lecture", "attend", "birthday")):
                        has_prior_message_sent = True
                        break

    # Check if chat conversation is already open on screen with contact_name
    if contact_name and not has_prior_click_contact and isinstance(sanitized_dom, list):
        for el in sanitized_dom:
            bbox = el.get("bbox") or {}
            x = bbox.get("x") or 0
            y = bbox.get("y") or 0
            if x >= 350 and y <= 150:
                txt = str(el.get("text") or el.get("label") or "").lower()
                if contact_name.lower() in txt:
                    has_prior_search = True
                    has_prior_click_contact = True
                    break

    # 1. Circuit breaker: if message already sent, return 'done'
    is_reasoning_done = bool(re.search(
        r'\b(task is complete|already typed|already sent|visible in chat|goal is accomplished|message has been sent)\b',
        resp.reasoning or '',
        re.I
    ))
    if has_prior_message_sent and (is_reasoning_done or resp.action.type == "done" or (resp.action.type == "type" and not resp.action.value)):
        print("[*] Auto-normalizing contact action: message was already sent in prior turn; converting to 'done'")
        resp.action.type = "done"
        resp.action.targetElementId = None
        resp.action.value = None
        resp.confidence = max(resp.confidence, 0.95)
        return resp

    contact_search_input = find_contact_search_input(sanitized_dom)
    msg_textbox = find_chat_message_textbox(sanitized_dom)

    # Step 1: If contact is specified and hasn't been searched yet
    if contact_name and not has_prior_search:
        if contact_search_input:
            search_id = contact_search_input.get("elementId") or contact_search_input.get("id")
            raw_val = contact_search_input.get("value") or (contact_search_input.get("attributes") or {}).get("value")
            cur_val = str(raw_val or "").strip()
            if contact_name.lower() not in cur_val.lower():
                if resp.action.type in ("click", "done") or resp.action.targetElementId != search_id or not resp.action.value:
                    print(f"[*] Auto-normalizing contact action: Step 1 typing contact '{contact_name}' into search input {search_id}")
                    resp.action.type = "type"
                    resp.action.targetElementId = search_id
                    resp.action.value = contact_name
                    resp.reasoning = f"Searching for contact '{contact_name}' in WhatsApp search bar."
                    resp.confidence = max(resp.confidence, 0.95)
                    return resp

    # Step 2: Contact was searched in prior action, now must click top contact result card on the left
    if contact_name and has_prior_search and not has_prior_click_contact:
        contact_el = None
        if isinstance(sanitized_dom, list):
            # First pass: find element whose label or text explicitly contains contact_name
            for el in sanitized_dom:
                if is_contact_result_item(el, contact_name=contact_name):
                    lbl = str(el.get("label") or "").lower()
                    txt = str(el.get("text") or "").lower()
                    if contact_name.lower() in lbl or contact_name.lower() in txt:
                        contact_el = el
                        break
            # Second pass: fallback to top contact result item in the search list
            if not contact_el:
                for el in sanitized_dom:
                    if is_contact_result_item(el, contact_name=contact_name):
                        contact_el = el
                        break
        if contact_el:
            contact_el_id = contact_el.get("elementId") or contact_el.get("id")
            # If model already clicked contact_el, preserve it!
            if resp.action.type == "click" and resp.action.targetElementId == contact_el_id:
                return resp
            # If model tried to type into bottom message box or emitted done prematurely, convert to click on contact
            if resp.action.type in ("done", "type") or resp.action.targetElementId != contact_el_id:
                print(f"[*] Auto-normalizing contact action: Step 2 selecting contact '{contact_name}' by clicking {contact_el_id}")
                resp.action.type = "click"
                resp.action.targetElementId = contact_el_id
                resp.action.value = None
                resp.reasoning = f"Clicking contact '{contact_name}' in search results to open chat conversation."
                resp.confidence = max(resp.confidence, 0.95)
                return resp

    # Step 3: Contact conversation is open (or prior click occurred / direct chat task), handle message box
    if msg_textbox:
        msg_id = msg_textbox.get("elementId") or msg_textbox.get("id")
        if resp.action.targetElementId == msg_id or (resp.action.type == "click" and not resp.action.targetElementId and (has_prior_click_contact or not contact_name)):
            resp.action.type = "type"
            resp.action.targetElementId = msg_id

        if resp.action.targetElementId == msg_id:
            resp.action.type = "type"
            if is_creative or is_prompt_echo(resp.action.value, clean_task):
                if is_prompt_echo(resp.action.value, clean_task):
                    print(f"[*] Auto-normalizing contact action: detected prompt echo or empty value '{resp.action.value}'; composing full creative text")
                    resp.action.value = compose_creative_fallback(clean_task)
                else:
                    print(f"[*] Auto-normalizing contact action: preserved creative text in action.value ({len(resp.action.value)} chars)")
            else:
                extracted = extract_message_text(clean_task)
                if extracted and (not resp.action.value or resp.action.type == "click"):
                    resp.action.value = extracted
                elif not resp.action.value and body:
                    resp.action.value = body

    return resp

def _normalize_select_dropdown_action(
    resp: InterpretResponse,
    task: str,
    sanitized_dom: Union[list, str, None],
    prior_actions: list = None
):
    """
    Normalizes select / dropdown actions:
    - If task mentions selecting an option from a dropdown or choosing a semester/value,
      finds the select element in sanitized_dom and sets action.type = 'select'.
    - If action targets a <select> element, forces action.type = 'select'.
    - Ensures action.value reflects the requested option.
    """
    if not resp or not resp.action:
        return

    clean_task = clean_task_text(task)
    is_dropdown_task = bool(
        re.search(r'\b(select|choose|pick)\b.*?\b(dropdown|semester|option|item|sem)\b', clean_task, re.I)
        or re.search(r'\b(first|second|third|fourth|forth|fifth|sixth|seventh|eighth|\d+(?:st|nd|rd|th)?)\s+sem(?:ester)?\b', clean_task, re.I)
    )

    # Check if target is already a select element
    target_is_select = False
    target_select_el = None
    if isinstance(sanitized_dom, list) and resp.action.targetElementId:
        for el in sanitized_dom:
            el_id = el.get("elementId") or el.get("id")
            if el_id == resp.action.targetElementId:
                if (el.get("tag") or "").lower() == "select" or el.get("inputType") == "select":
                    target_is_select = True
                    target_select_el = el
                break

    # If it's a dropdown task and target is not a select, find the matching select element in DOM
    if is_dropdown_task and not target_is_select and isinstance(sanitized_dom, list):
        for el in sanitized_dom:
            tag = (el.get("tag") or "").lower()
            inp_type = (el.get("inputType") or "").lower()
            lbl = (el.get("label") or "").lower()
            eid = str(el.get("elementId") or el.get("id") or "").lower()
            if tag == "select" or inp_type == "select":
                if "semester" in clean_task.lower() or "sem" in clean_task.lower():
                    if "semester" in lbl or "sem" in lbl or "semester" in eid or "sem" in eid:
                        target_select_el = el
                        target_is_select = True
                        resp.action.targetElementId = el.get("elementId") or el.get("id")
                        break
                if not target_select_el:
                    target_select_el = el
                    target_is_select = True
                    resp.action.targetElementId = el.get("elementId") or el.get("id")

    if target_is_select:
        resp.action.type = "select"
        if not resp.action.value and is_dropdown_task:
            m = re.search(r'\b(first|second|third|fourth|forth|fifth|sixth|seventh|eighth|\d+(?:st|nd|rd|th)?)(?:\s+sem(?:ester)?)?\b', clean_task, re.I)
            if m:
                resp.action.value = m.group(0).strip()
            else:
                resp.action.value = clean_task
        print(f"[*] Auto-normalizing dropdown action: target={resp.action.targetElementId}, value='{resp.action.value}', type='select'")

def is_travel_booking_task(task: str, sanitized_dom: Union[list, str, None] = None) -> bool:
    """Checks if the user prompt or DOM relates to train, flight, or travel booking."""
    clean_task = clean_task_text(task).lower()
    if re.search(r'\b(book|ticket|train|irctc|railway|tatkal|journey|flight|bus|reservation|seat)\b', clean_task):
        return True
    if isinstance(sanitized_dom, list):
        for el in sanitized_dom:
            txt = f"{el.get('text', '')} {el.get('label', '')} {el.get('placeholder', '')} {el.get('elementId', '')}".lower()
            if any(k in txt for k in ["search trains", "find trains", "book ticket", "p-autocomplete", "origin", "destination", "irctc"]):
                return True
    return False

def find_travel_booking_elements(sanitized_dom: Union[list, str, None]) -> dict:
    """Extracts From, To, Date, Class, and Search button elements from sanitized DOM."""
    result = {
        "from_input": None,
        "to_input": None,
        "date_input": None,
        "class_select": None,
        "search_button": None
    }
    if not isinstance(sanitized_dom, list):
        return result

    for el in sanitized_dom:
        tag = (el.get("tag") or "").lower()
        lbl = str(el.get("label") or "").lower()
        ph = str(el.get("placeholder") or "").lower()
        txt = str(el.get("text") or "").lower()
        eid = str(el.get("elementId") or el.get("id") or "").lower()
        inp_type = str(el.get("inputType") or "").lower()
        widget_type = str(el.get("widgetType") or "").lower()

        # From / Origin
        if not result["from_input"]:
            if (("from" in lbl or "from" in ph or "origin" in eid or "source" in eid) and "to" not in lbl and "to" not in ph):
                result["from_input"] = el
            elif widget_type == "autocomplete" and not result["to_input"]:
                result["from_input"] = el

        # To / Destination
        if not result["to_input"]:
            if ("to" in lbl or "to" in ph or "destination" in eid or "dest" in eid) and "from" not in lbl and "from" not in ph:
                result["to_input"] = el
            elif widget_type == "autocomplete" and result["from_input"] and el != result["from_input"]:
                result["to_input"] = el

        # Date input
        if not result["date_input"]:
            if "date" in lbl or "date" in ph or "journey" in lbl or "calendar" in eid or inp_type == "date" or widget_type == "datepicker":
                result["date_input"] = el

        # Class select / dropdown
        if not result["class_select"]:
            if "class" in lbl or "classes" in ph or "quota" in lbl or widget_type == "dropdown":
                result["class_select"] = el

        # Search button
        if not result["search_button"]:
            if ("search trains" in txt or "find trains" in txt or "search train" in txt or
                "train_search" in eid or "search_btn" in eid or ("search" in txt and tag in ("button", "a"))):
                result["search_button"] = el

    return result

def extract_travel_station_query(task: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Extracts (from_station, to_station, date) if explicitly mentioned in task text."""
    clean = clean_task_text(task)
    from_st = None
    to_st = None
    date_val = None

    # Matches "from <origin> to <dest>"
    m = re.search(r'\bfrom\s+([A-Za-z0-9\s/]+?)\s+to\s+([A-Za-z0-9\s/]+?)(?:\s+(?:on|for|at|date)\s+|$)', clean, re.I)
    if m:
        from_st = m.group(1).strip()
        to_st = m.group(2).strip()
    else:
        mf = re.search(r'\bfrom\s+([A-Za-z0-9\s/]+?)(?:\s+to|\s+on|\s+date|\s+in|$)', clean, re.I)
        if mf:
            from_st = mf.group(1).strip()
        mt = re.search(r'\bto\s+([A-Za-z0-9\s/]+?)(?:\s+from|\s+on|\s+date|\s+in|$)', clean, re.I)
        if mt:
            to_st = mt.group(1).strip()

    md = re.search(r'\b(?:on|date)\s+([0-9\/\-]+|[0-9]{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+(?:\s+[0-9]{4})?|tomorrow|today)', clean, re.I)
    if md:
        date_val = md.group(1).strip()

    return from_st, to_st, date_val

def _normalize_travel_booking_action(
    resp: InterpretResponse,
    task: str,
    sanitized_dom: Union[list, str, None],
    prior_actions: list = None
) -> None:
    """
    Prevents premature clicks on 'Search Trains' or 'Search' buttons before From/To stations are entered.
    If details are missing, converts the action to 'ask_user' requesting details locally.
    """
    if not resp or not resp.action:
        return

    if not is_travel_booking_task(task, sanitized_dom):
        return

    elements = find_travel_booking_elements(sanitized_dom)
    from_el = elements.get("from_input")
    to_el = elements.get("to_input")
    search_btn = elements.get("search_button")

    # Check if from and to inputs currently have values in DOM or prior actions
    from_val = from_el.get("value") if from_el else None
    to_val = to_el.get("value") if to_el else None

    # Check prior actions for type or fill_form on from / to
    has_prior_from_fill = False
    has_prior_to_fill = False
    if prior_actions:
        for act in prior_actions:
            act_str = str(act).lower()
            if "fill_form" in act_str or "filled" in act_str:
                has_prior_from_fill = True
                has_prior_to_fill = True
                break
            if "type" in act_str:
                if from_el and (from_el.get("elementId") or "").lower() in act_str:
                    has_prior_from_fill = True
                if to_el and (to_el.get("elementId") or "").lower() in act_str:
                    has_prior_to_fill = True

    is_from_empty = not from_val and not has_prior_from_fill
    is_to_empty = not to_val and not has_prior_to_fill

    search_btn_id = (search_btn.get("elementId") or search_btn.get("id")) if search_btn else None
    is_clicking_search = (
        resp.action.type == "click" and (
            (search_btn_id and resp.action.targetElementId == search_btn_id)
            or re.search(r'\b(search\s*train|search|proceed\s+with\s+booking|submit\s+search)\b', resp.reasoning or '', re.I)
            or re.search(r'\b(search\s*train|primary\s+action\s+to\s+proceed)\b', str(resp.assumptions or ''), re.I)
        )
    )

    # If from or to are empty, WE CANNOT CLICK SEARCH TRAINS OR EMIT DONE!
    if is_from_empty or is_to_empty:
        if is_clicking_search or resp.action.type == "done":
            print("[*] Circuit-breaker: Blocked premature search click or done because journey details are empty!")
            req_from, req_to, req_date = extract_travel_station_query(task)

            from_desc = f"Enter departure station (e.g. '{req_from}')" if req_from else "Enter departure station (e.g. New Delhi / NDLS)"
            to_desc = f"Enter destination station (e.g. '{req_to}')" if req_to else "Enter destination station (e.g. Mumbai / BCT)"
            date_desc = f"Select your date ({req_date})" if req_date else "Select your travel date"

            # Guide user to fill the details on-page
            resp.action.type = "wait"
            resp.action.targetElementId = None
            ask_payload = {
                "title": "Enter Journey Details on IRCTC",
                "question": "Please fill in your travel stations and date directly on the page before proceeding:",
                "fields": [
                    {"name": "from", "label": "From Station", "description": from_desc},
                    {"name": "to", "label": "To Station", "description": to_desc},
                    {"name": "date", "label": "Journey Date", "description": date_desc},
                    {"name": "class", "label": "Class / Quota", "description": "Choose your desired coach class"}
                ]
            }
            resp.action.value = json.dumps(ask_payload)
            resp.action.scrollDirection = None
            resp.needsClarification = True
            resp.reasoning = (
                f"Please fill your From Station ({req_from or 'origin'}), To Station ({req_to or 'destination'}), and Journey Date directly on the page. "
                "Click 'Show Me Where' to highlight them, then click Continue once filled."
            )
            resp.assumptions = ["IRCTC requires From and To station inputs before searching trains."]
            resp.confidence = max(resp.confidence, 0.95)
            print("[*] Converted premature search click to on-page guidance for user.")

def _normalize_action(
    resp: InterpretResponse,
    task: str,
    sanitized_dom: Union[list, str, None],
    prior_actions: list = None
) -> InterpretResponse:
    """
    Normalizes and fixes model actions for search, chat/messaging, travel booking, contact selection, and clicks with text values.
    """
    if not resp or not resp.action:
        return resp

    # 1. Normalize travel booking & IRCTC tasks (circuit-breaker for premature search)
    _normalize_travel_booking_action(resp, task, sanitized_dom, prior_actions=prior_actions)

    # 2. Normalize contact search & messaging tasks (WhatsApp multi-step sequence)
    _normalize_contact_chat_action(resp, task, sanitized_dom, prior_actions=prior_actions)

    # 3. Normalize search tasks (YouTube, Flipkart, Amazon)
    _normalize_search_action(resp, task, sanitized_dom, prior_actions=prior_actions)

    # 4. Normalize select dropdown tasks
    _normalize_select_dropdown_action(resp, task, sanitized_dom, prior_actions=prior_actions)

    # 4. If action has type='click' but non-empty value, model intended to type (unless target is a select)
    if resp.action.type == "click" and resp.action.value:
        target_is_select = False
        if isinstance(sanitized_dom, list) and resp.action.targetElementId:
            for el in sanitized_dom:
                if (el.get("elementId") or el.get("id")) == resp.action.targetElementId:
                    if (el.get("tag") or "").lower() == "select" or el.get("inputType") == "select":
                        target_is_select = True
                    break
        if target_is_select:
            resp.action.type = "select"
        else:
            print(f"[*] Auto-normalizing action: converted 'click' with value '{resp.action.value}' to 'type'")
            resp.action.type = "type"

    # 4. Standard chat/messaging fallback if not already handled
    contact_name, _ = parse_contact_task(clean_task_text(task))
    is_creative = is_creative_generation_task(task)
    chat_intent = bool(
        is_creative or
        re.search(r'\b(send|type|write|message|say|chat|tell|text|draft)\b', task, re.I)
    )
    if chat_intent and not contact_name:
        has_prior_message_sent = False
        if prior_actions:
            for act in prior_actions:
                act_str = str(act).lower()
                if "type" in act_str and ("sent" in act_str or "outcome: executed" in act_str or "message" in act_str):
                    has_prior_message_sent = True
                    break

        # If a prior message was already sent and reasoning indicates completion, or action is type with empty value:
        is_reasoning_done = bool(re.search(r'\b(task is complete|already typed|already sent|visible in chat|goal is accomplished|message has been sent)\b', resp.reasoning or '', re.I))
        if has_prior_message_sent and (is_reasoning_done or (resp.action.type == "type" and not resp.action.value)):
            print("[*] Auto-normalizing chat action: message was already sent in prior turn; converting to 'done'")
            resp.action.type = "done"
            resp.action.targetElementId = None
            resp.action.value = None
            resp.confidence = max(resp.confidence, 0.95)
            return resp

        if resp.action.targetElementId and not has_prior_message_sent:
            is_textbox = False
            if isinstance(sanitized_dom, list):
                for el in sanitized_dom:
                    el_id = el.get("elementId") or el.get("id")
                    if el_id == resp.action.targetElementId:
                        tag = (el.get("tag") or "").lower()
                        role = (el.get("role") or "").lower()
                        attrs = el.get("attributes") or {}
                        ph = (el.get("placeholder") or attrs.get("placeholder") or "").lower()
                        lbl = (el.get("label") or attrs.get("aria-label") or "").lower()
                        if "search" in ph or "search" in lbl or "search" in str(el_id).lower():
                            is_textbox = False
                            break
                        if role == "textbox" or tag in ("textarea", "input") or "message" in ph or "type" in ph:
                            is_textbox = True
                        break
            if is_textbox:
                is_creative = is_creative_generation_task(task)
                if is_creative or is_prompt_echo(resp.action.value, task):
                    if is_prompt_echo(resp.action.value, task):
                        print(f"[*] Auto-normalizing chat action: detected prompt echo or empty value '{resp.action.value}'; composing full creative text")
                        resp.action.value = compose_creative_fallback(task)
                else:
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
        _normalize_action(validated, task, sanitized_dom, prior_actions=prior_actions)
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
        _normalize_action(validated_retry, task, sanitized_dom, prior_actions=prior_actions)
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