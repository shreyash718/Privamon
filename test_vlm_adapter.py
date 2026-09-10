import sys, os, base64, io
from PIL import Image

sys.path.append(os.path.abspath("server_side_agent"))
import model_client

def test_png_optimization():
    # Create test image with red square
    img = Image.new("RGBA", (1400, 800), (255, 0, 0, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64_in = base64.b64encode(buf.getvalue()).decode("utf-8")

    out_b64 = model_client.optimize_image_b64(b64_in, max_dimension=1152)
    out_bytes = base64.b64decode(out_b64)
    out_img = Image.open(io.BytesIO(out_bytes))

    print(f"[TEST PNG] Resized: {img.size} -> {out_img.size}, format: {out_img.format}")
    assert out_img.format == "PNG", f"Expected PNG format, got {out_img.format}"
    assert max(out_img.size) == 1152, f"Expected max dimension 1152, got {max(out_img.size)}"
    assert out_img.mode == "RGB", f"Expected RGB mode, got {out_img.mode}"

def test_ollama_payload():
    payload = model_client.build_request_payload(
        provider="ollama",
        prompt="Click submit",
        image_b64="fakeb64data",
        schema=model_client.STRICT_ACTION_SCHEMA,
        model="qwen3-vl:2b"
    )
    assert payload["model"] == "qwen3-vl:2b"
    assert "images" in payload and payload["images"] == ["fakeb64data"]
    assert "format" in payload and isinstance(payload["format"], dict)
    assert set(payload["format"]["required"]) == {"reasoning", "confidence", "action", "assumptions", "needsClarification"}
    print("[TEST OLLAMA PAYLOAD] Passed!")

def test_openrouter_payload():
    payload = model_client.build_request_payload(
        provider="openrouter",
        prompt="Click submit",
        image_b64="fakeb64data",
        schema=model_client.STRICT_ACTION_SCHEMA,
        model="qwen/qwen-2.5-vl-72b-instruct:free"
    )
    assert payload["model"] == "qwen/qwen-2.5-vl-72b-instruct:free"
    assert "messages" in payload and len(payload["messages"]) == 1
    content = payload["messages"][0]["content"]
    assert content[0]["type"] == "text" and content[0]["text"] == "Click submit"
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert "response_format" in payload
    assert payload["response_format"]["type"] == "json_schema"
    assert payload["response_format"]["json_schema"]["strict"] is True
    print("[TEST OPENROUTER PAYLOAD] Passed!")

def test_strict_schema_additional_properties():
    schema = model_client.STRICT_ACTION_SCHEMA
    assert schema.get("additionalProperties") is False, "Root schema must have additionalProperties: False"
    assert schema["properties"]["action"].get("additionalProperties") is False, "Action object must have additionalProperties: False"
    print("[TEST SCHEMA ADDITIONAL_PROPERTIES] Passed!")

def test_provider_model_lookup():
    ollama_model = model_client.get_model_for_provider("ollama")
    openrouter_model = model_client.get_model_for_provider("openrouter")
    assert ollama_model == "qwen3-vl:2b"
    assert "qwen" in openrouter_model.lower()
    assert ollama_model != openrouter_model
    print(f"[TEST PROVIDER MODEL LOOKUP] Ollama={ollama_model}, OpenRouter={openrouter_model} - Passed!")

def test_format_dom_with_pos():
    sample_dom = [
        {"elementId": "dom-tok-1", "tag": "button", "label": "Submit", "pos": "top-right"},
        {"elementId": "dom-tok-2", "tag": "button", "label": "Submit", "pos": "bottom-right"},
    ]
    formatted = model_client.format_dom_for_prompt(sample_dom, max_elements=20)
    print("[TEST DOM FORMATTING]\n" + formatted)
    assert "[pos: top-right]" in formatted
    assert "[pos: bottom-right]" in formatted
    assert "dom-tok-1" in formatted and "dom-tok-2" in formatted

if __name__ == "__main__":
    test_png_optimization()
    test_strict_schema_additional_properties()
    test_provider_model_lookup()
    test_ollama_payload()
    test_openrouter_payload()
    test_format_dom_with_pos()
    print("\nALL PYTHON VLM ADAPTER TESTS PASSED SUCCESSFULLY!")
