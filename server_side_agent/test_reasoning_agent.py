import sys, os
sys.path.insert(0, os.path.abspath('server_side_agent'))

from model_client import parse_and_validate
from schemas import InterpretResponse, ActionPayload

# Test 1: Exact schema
t1 = '{"reasoning": "Click submit button.", "confidence": 0.95, "action": {"type": "click", "targetElementId": "btn-1", "value": null, "scrollDirection": null}, "assumptions": ["Primary button"], "needsClarification": false}'
v1, err1 = parse_and_validate(t1)
assert v1 is not None, f"Test 1 failed: {err1}"
assert v1.action.type == 'click'
assert v1.action.targetElementId == 'btn-1'
assert v1.confidence == 0.95
assert err1 is None
print("✓ Test 1 (Exact schema) passed")

# Test 2: Wrapped in markdown code block
t2 = '```json\n' + t1 + '\n```'
v2, err2 = parse_and_validate(t2)
assert v2 is not None, f"Test 2 failed: {err2}"
assert v2.action.targetElementId == 'btn-1'
print("✓ Test 2 (Markdown block stripping) passed")

# Test 3: Legacy format auto-normalization
t3 = '{"actions": [{"type": "type", "targetElementId": "input-3", "value": "test@example.com", "reasoning": "fill email"}], "message": "Type email"}'
v3, err3 = parse_and_validate(t3)
assert v3 is not None, f"Test 3 failed: {err3}"
assert v3.action.type == 'type'
assert v3.action.value == 'test@example.com'
assert v3.action.targetElementId == 'input-3'
print("✓ Test 3 (Legacy format normalization) passed")

# Test 4: Invalid schema detected
t4 = '{"action": "not a dict"}'
v4, err4 = parse_and_validate(t4)
assert v4 is None or err4 is not None, "Test 4 should have detected invalid schema"
print("✓ Test 4 (Invalid schema rejection) passed")

# Test 5: String action shorthand & auto reasoning default
t5 = '{"action": "click", "target": "btn-5"}'
v5, err5 = parse_and_validate(t5)
assert v5 is not None, f"Test 5 failed: {err5}"
assert v5.action.type == 'click'
assert v5.action.targetElementId == 'btn-5'
assert v5.reasoning is not None and len(v5.reasoning) > 0
print("✓ Test 5 (String action shorthand & auto reasoning default) passed")

print("\nAll 5 reasoning agent validation tests PASSED!")
