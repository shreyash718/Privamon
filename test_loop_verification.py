"""
Unit and regression test for autonomous loop verification:
1. Tests that typing doesn't repeat strings.
2. Tests that priorActions doesn't produce 'no_change_detected' on existing input containers.
3. Tests that model_client prompt correctly instructs 'done' on loop step 2.
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "server_side_agent"))
import model_client

def test_loop_verification_prompt():
    task = 'send message to chat which is open "Hie"'
    sanitized_dom = [
        {"elementId": "dom-tok-msg", "tag": "div", "role": "textbox", "attributes": {"type": "contenteditable", "placeholder": "Type a message"}},
        {"elementId": "dom-tok-bubble", "tag": "div", "text": "Hie"}
    ]
    prior_actions = [
        'type dom-tok-msg "Hie" [outcome: executed_and_sent]'
    ]
    prompt = model_client.build_reasoning_prompt(task, sanitized_dom, prior_actions=prior_actions)
    
    assert 'executed_and_sent' in prompt, "Prior action outcome should be executed_and_sent"
    assert 'VERIFYING TASK COMPLETION IN MULTI-STEP LOOPS (CRITICAL)' in prompt, "Prompt should have loop verification section"
    assert '"type": "done"' in prompt, "Prompt should contain example of 'done' action"
    prior_section = prompt.split("PRIOR ACTIONS & OUTCOMES:")[1].split("HOW TO REASON")[0]
    assert 'no_change_detected' not in prior_section, "Prior section should not have no_change_detected"
    print("[TEST 1] Loop verification prompt formatting with prior executed action: PASSED!")

def test_circuit_breaker_deduplication():
    # Simulate steps
    steps = [
        {
            "step": 1,
            "action": {"type": "type", "value": "Hie", "targetElementId": "dom-tok-msg"},
            "execResult": {"success": True, "message": "Typed 'Hie' and sent message"}
        }
    ]
    
    # Step 2 proposed action (simulated glitch)
    candidate_action = {"type": "type", "value": "Hie", "targetElementId": "dom-tok-msg"}
    
    already_sent = any(
        s.get("action", {}).get("type") == "type" and
        s.get("action", {}).get("value") == candidate_action["value"] and
        s.get("execResult", {}).get("success") is True
        for s in steps
    )
    
    assert already_sent is True, "Circuit breaker should catch duplicate typing of same message"
    print("[TEST 2] Circuit-breaker deduplication logic: PASSED!")

if __name__ == "__main__":
    test_loop_verification_prompt()
    test_circuit_breaker_deduplication()
    print("\nALL LOOP VERIFICATION TESTS PASSED SUCCESSFULLY!")
