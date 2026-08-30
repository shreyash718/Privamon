import requests, json

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL_NAME = "qwen3-vl:2b"

def build_prompt(task: str, redacted_regions: list, sanitized_dom: str = "") -> str:
    dom_text = ""
    if sanitized_dom:
        dom_text = f"\nSanitized DOM Context:\n{sanitized_dom}\n"
        
    return f"""You are a screen automation agent.
Task: {task}
{dom_text}
Some regions are intentionally redacted for privacy: {json.dumps(redacted_regions)}
Do NOT guess what's inside redacted regions.

Return ONLY valid JSON in this format:
{{"actions": [{{"type": "click", "target_bbox": [x1,y1,x2,y2], "value": null, "reasoning": "why"}}]}}
"""

def run_inference(image_b64: str, task: str, redacted_regions: list, sanitized_dom: str = "") -> str:
    # Strip data URI prefix if present (e.g., "data:image/png;base64,...")
    if "," in image_b64 and image_b64.startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]

    prompt = build_prompt(task, redacted_regions, sanitized_dom)
    print(f"[*] Sending request to Ollama for task: '{task}'...")
    
    resp = requests.post(OLLAMA_URL, json={
        "model": MODEL_NAME,
        "prompt": prompt,
        "images": [image_b64],
        "format": "json",
        "stream": True
    }, stream=True, timeout=180)
    
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
                print(f"\033[90m{chunk['thinking']}\033[0m", end="", flush=True) # Print thinking in gray
            if "response" in chunk and chunk["response"]:
                text_chunk = chunk["response"]
                print(f"\033[92m{text_chunk}\033[0m", end="", flush=True) # Print response in green
                full_response += text_chunk
                
    if not full_thinking and not full_response:
        print("\n[!] Warning: Model returned completely empty output (no thinking, no response).")
    
    print("\n[*] Finished generating response.")
    
    # Sometimes reasoning models forget to close the thinking tag and put their entire output in the thinking block.
    # If the response is empty but thinking isn't, use the thinking block as the response.
    final_output = full_response.strip()
    if not final_output and full_thinking.strip():
        final_output = full_thinking.strip()
        
    return final_output