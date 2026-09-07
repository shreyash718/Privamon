import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "server_side_agent"))

import model_client

def compute_coarse_position(bbox, vp):
    mid_x = bbox["x"] + bbox.get("width", 0) / 2
    mid_y = bbox["y"] + bbox.get("height", 0) / 2
    v_pos = "top" if mid_y < vp["h"] * 0.33 else ("mid" if mid_y < vp["h"] * 0.66 else "bot")
    h_pos = "left" if mid_x < vp["w"] * 0.33 else ("center" if mid_x < vp["w"] * 0.66 else "right")
    return f"{v_pos}-{h_pos}"

def rank_dom_elements_py(sanitized_dom, task, vp, max_elements=35):
    task_lower = (task or "").lower()
    has_type_intent = any(w in task_lower for w in ["type", "enter", "fill", "input", "write", "search", "set", "send", "message", "reply", "post", "chat", "say", "text"]) or ('"' in task_lower)
    has_click_intent = any(w in task_lower for w in ["click", "press", "tap", "select", "submit", "choose", "open"])

    task_tokens = [w for w in task_lower.replace('"', " ").split() if len(w) > 1]

    scored = []
    for idx, el in enumerate(sanitized_dom):
        tag = (el.get("tag") or "elem").lower()
        role = (el.get("role") or "").lower()
        pos = compute_coarse_position(el.get("bbox", {"x": 0, "y": 0}), vp)

        is_input_tag = tag in ["input", "textarea", "select"]
        is_input_role = role in ["textbox", "combobox", "searchbox"]
        is_content_editable = bool(el.get("isContentEditable") or el.get("inputType") == "contenteditable" or (el.get("attributes") or {}).get("type") == "contenteditable")
        is_input = is_input_tag or is_input_role or is_content_editable

        is_interactive_tag = is_input_tag or tag in ["button", "a"]
        is_interactive_role = is_input_role or role in ["button", "link", "checkbox", "radio", "menuitem", "tab"]

        score = 0
        if is_interactive_tag or is_interactive_role or is_content_editable:
            score += 10
        if has_click_intent and (tag in ["button", "a"] or role in ["button", "link"]):
            score += 8
        if has_type_intent and is_input:
            score += 15

        ph_val = el.get("placeholder") or (el.get("attributes") or {}).get("placeholder") or ""
        searchable_text = " ".join([
            str(el.get("label") or ""),
            ph_val,
            str(el.get("text") or ""),
            str(el.get("id") or ""),
            str(el.get("elementId") or ""),
            str(el.get("name") or ""),
            str(el.get("inputType") or ""),
            role
        ]).lower()

        for token in task_tokens:
            if token in searchable_text:
                score += 6

        if is_input and any(k in searchable_text for k in ["message", "chat", "reply", "type a message", "send"]):
            score += 12

        # Audio/Voice record button detection penalty
        is_audio_record = bool(el.get("isAudioRecord") or any(k in searchable_text for k in ["voice message", "ptt", "record audio", "microphone", "voice note"]))
        if has_type_intent and is_audio_record:
            score -= 50

        if has_type_intent and is_input and not is_audio_record and pos.startswith("bot"):
            score += 8
        elif pos.startswith("top"):
            score += 2
        elif pos.startswith("mid"):
            score += 1

        scored.append({
            "elementId": el.get("elementId") or f"dom-tok-{idx}",
            "tag": tag,
            "role": role or None,
            "pos": pos,
            "label": el.get("label"),
            "text": el.get("text"),
            "attributes": {
                "type": el.get("inputType") or ("contenteditable" if is_content_editable else None),
                "placeholder": ph_val or None,
                "value": el.get("value")
            },
            "_isInput": is_input,
            "_score": score
        })

    scored.sort(key=lambda x: x["_score"], reverse=True)
    return scored[:max_elements]

def test_whatsapp_ranking_and_prompt():
    vp = {"w": 1280, "h": 800}

    # Simulate 25 sidebar chats, 5 header icons, 1 microphone button, and 1 message box at bottom
    dom_elements = []
    # 20 sidebar chats
    for i in range(20):
        dom_elements.append({
            "elementId": f"dom-tok-{i}",
            "tag": "div",
            "role": "button",
            "label": f"Chat contact {i}",
            "text": f"Contact message snippet {i}",
            "bbox": {"x": 50, "y": 80 + i * 35, "width": 250, "height": 30}
        })
    # 5 header buttons
    for i in range(5):
        dom_elements.append({
            "elementId": f"dom-tok-h{i}",
            "tag": "button",
            "role": "button",
            "label": f"Header action {i}",
            "bbox": {"x": 800 + i * 40, "y": 20, "width": 30, "height": 30}
        })
    # The microphone button in footer (e.g. dom-tok-630)
    dom_elements.append({
        "elementId": "dom-tok-mic",
        "tag": "button",
        "role": "button",
        "label": "Voice message (Microphone / Voice Record Button - NOT A TEXTBOX)",
        "isAudioRecord": True,
        "bbox": {"x": 1200, "y": 750, "width": 40, "height": 40}
    })
    # The actual WhatsApp message input at the bottom
    dom_elements.append({
        "elementId": "dom-tok-msg",
        "tag": "div",
        "role": "textbox",
        "isContentEditable": True,
        "inputType": "contenteditable",
        "label": "Type a message",
        "placeholder": "Type a message",
        "bbox": {"x": 450, "y": 750, "width": 700, "height": 40}
    })

    task = 'send message to chat which is open "Hie"'
    ranked = rank_dom_elements_py(dom_elements, task, vp, max_elements=35)

    # 1. Verify that the message input is ranked #1 and mic button is heavily penalized
    top_element = ranked[0]
    print(f"[TEST 1] Top ranked element: {top_element['elementId']} ({top_element['role']}) score={top_element['_score']}")
    assert top_element["elementId"] == "dom-tok-msg", f"Expected dom-tok-msg to be #1, got {top_element['elementId']}"
    assert top_element["_isInput"] is True

    mic_element = next(e for e in ranked if e["elementId"] == "dom-tok-mic")
    print(f"[TEST 1] Microphone button score: {mic_element['_score']}")
    assert mic_element["_score"] < 0, f"Expected mic to have negative score due to penalty, got {mic_element['_score']}"
    print("[TEST 1] WhatsApp message input ranked #1 and mic button penalized! Passed.")

    # 2. Verify prompt formatting includes placeholder
    formatted_dom = model_client.format_dom_for_prompt(ranked, max_elements=35)
    print("\n[TEST 2] Formatted DOM representation for top element:")
    first_line = formatted_dom.split("\n")[0]
    print(first_line)
    assert 'placeholder="Type a message"' in first_line
    assert 'role="textbox"' in first_line
    assert 'type="contenteditable"' in first_line
    print("[TEST 2] Formatted DOM string includes placeholder, role, and type! Passed.")

    # 3. Verify reasoning prompt contract doesn't have hardcoded dom-tok-12
    prompt = model_client.build_reasoning_prompt(task, ranked)
    empty_prompt = model_client.build_reasoning_prompt(task, [])
    assert "dom-tok-12" not in empty_prompt, "Found hardcoded dom-tok-12 in prompt contract!"
    assert "<exact_elementId_from_list>" in prompt
    assert "SPECIAL GUIDANCE FOR CHAT & MESSAGING:" in prompt
    print("[TEST 3] Prompt contract anti-hallucination and messaging guidance! Passed.")

    # 4. Verify STRICT_ACTION_SCHEMA allows valid action response
    from schemas import InterpretResponse, ActionPayload
    valid_resp = InterpretResponse(
        reasoning="Identified active message input. Typing 'Hie' into the chat box.",
        confidence=0.98,
        action=ActionPayload(
            type="type",
            targetElementId="dom-tok-msg",
            value="Hie",
            scrollDirection=None
        ),
        assumptions=["Chat with Tanishq is open"],
        needsClarification=False
    )
    assert valid_resp.action.type == "type"
    assert valid_resp.action.targetElementId == "dom-tok-msg"
    assert valid_resp.action.value == "Hie"
    print("[TEST 4] InterpretResponse schema validation for typing action! Passed.")

    print("\nALL WHATSAPP DOM & PROMPT TESTS PASSED!")

if __name__ == "__main__":
    test_whatsapp_ranking_and_prompt()
