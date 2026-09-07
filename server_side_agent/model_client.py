import requests, json, io, base64
from PIL import Image

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL_NAME = "qwen3-vl:2b"

def optimize_image_b64(b64_str: str, max_dimension: int = 1024) -> str:
    """
    Optimizes base64 screenshot for VLM consumption:
    - Downscales images larger than max_dimension to dramatically cut token count
    - Converts to high-quality JPEG to minimize memory and transmission overhead
    """
    try:
        raw_bytes = base64.b64decode(b64_str)
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
        return b64_str

def build_prompt(task: str, redacted_regions: list, sanitized_dom: str = "") -> str:
    dom_text = ""
    if sanitized_dom:
        # Limit DOM text to 2000 chars to avoid token bloat
        clipped_dom = sanitized_dom[:2000]
        if len(sanitized_dom) > 2000:
            clipped_dom += "\n...[truncated]"
        dom_text = f"\nSanitized DOM Context:\n{clipped_dom}\n"
        
    # Limit redacted regions list to avoid token overflow
    sample_regions = redacted_regions[:20] if isinstance(redacted_regions, list) else []
    
    return f"""You are a screen automation agent.
Task: {task}
{dom_text}
Redacted privacy regions: {json.dumps(sample_regions)}
Do NOT guess what is inside redacted regions.

Return ONLY valid JSON in this format:
{{"actions": [{{"type": "click", "target_bbox": [x1,y1,x2,y2], "value": null, "reasoning": "why"}}], "message": "explanation of what to do"}}
"""

def run_inference(image_b64: str, task: str, redacted_regions: list, sanitized_dom: str = "") -> tuple[str, str]:
    # Strip data URI prefix if present (e.g., "data:image/png;base64,...")
    if "," in image_b64 and image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]

    # Optimize and resize image to fit VLM context window efficiently
    optimized_image_b64 = optimize_image_b64(image_b64, max_dimension=1024)
    prompt = build_prompt(task, redacted_regions, sanitized_dom)
    
    print(f"[*] Sending request to Ollama for task: '{task}' with context size 16384...")
    
    payload = {
        "model": MODEL_NAME,
        "prompt": prompt,
        "images": [optimized_image_b64],
        "format": "json",
        "stream": True,
        "options": {
            "num_ctx": 16384,
            "temperature": 0.2
        }
    }
    
    resp = requests.post(OLLAMA_URL, json=payload, stream=True, timeout=180)
    
    if resp.status_code != 200:
        raise Exception(f"Ollama API error {resp.status_code}: {resp.text}")
        
    print("\n[*] Model generating: ")
    full_response = ""
    full_thinking = ""
    
    for line in resp.iter_lines():
        if line:
            chunk = json.loads(line)
            if "thinking" in chunk and chunk["thinking"]:
                full_thinking += chunk["thinking"]
                print(f"\033[90m{chunk['thinking']}\033[0m", end="", flush=True)
            if "response" in chunk and chunk["response"]:
                text_chunk = chunk["response"]
                print(f"\033[92m{text_chunk}\033[0m", end="", flush=True)
                full_response += text_chunk
                
    if not full_thinking and not full_response:
        print("\n[!] Warning: Model returned completely empty output.")
    
    print("\n[*] Finished generating response.")
    
    final_output = full_response.strip()
    thinking_output = full_thinking.strip()
    if not final_output and thinking_output:
        final_output = thinking_output
        
    return final_output, thinking_output