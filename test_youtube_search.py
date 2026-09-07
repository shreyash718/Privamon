import sys, os, re
sys.path.insert(0, os.path.abspath('server_side_agent'))

from model_client import extract_search_query, _normalize_search_action, parse_and_validate

# 1. Query Extraction Tests
test_queries = [
    ("search Indias got latent and play most viewed video", "Indias got latent"),
    ('search "Khat" and play first video that appears', "Khat"),
    ('On this site search "Khat" and play first video that appears', "Khat"),
    ("search lo fi songs on youtube", "lo fi songs"),
    ("search for funny dog videos", "funny dog videos"),
    ("find taylor swift blank space", "taylor swift blank space"),
    ("search Khat", "Khat"),
]

for task, expected in test_queries:
    extracted = extract_search_query(task)
    assert extracted == expected, f"Failed for {task!r}: expected {expected!r}, got {extracted!r}"
print("✓ [TEST 1] Query extraction passed for all YouTube tasks!")

# 2. Defense-in-depth Auto-normalization (Model emitting click on search input converted to type)
raw_click = (
    '{"reasoning": "To search for \'Indias got latent\', I need to click on the search bar to enter the query.", '
    '"confidence": 0.95, "action": {"type": "click", "targetElementId": "dom-tok-18", "value": null, "scrollDirection": null}, '
    '"assumptions": ["Search bar is ready"], "needsClarification": false}'
)
resp, err = parse_and_validate(raw_click)
assert resp is not None and err is None

mock_yt_dom = [
    {"elementId": "dom-tok-18", "tag": "input", "id": "search", "name": "search_query", "placeholder": "Search", "role": "combobox"},
    {"elementId": "dom-tok-19", "tag": "button", "id": "search-icon-legacy", "label": "Search"},
    {"elementId": "dom-tok-20", "tag": "button", "id": "voice-search-button", "label": "Search with your voice", "isAudioRecord": True}
]

norm_resp = _normalize_search_action(resp, "search Indias got latent and play most viewed video", mock_yt_dom)
assert norm_resp.action.type == "type", f"Expected 'type', got {norm_resp.action.type}"
assert norm_resp.action.value == "Indias got latent", f"Expected query 'Indias got latent', got {norm_resp.action.value}"
assert norm_resp.action.targetElementId == "dom-tok-18"
assert "Indias got latent" in norm_resp.reasoning
print("✓ [TEST 2] Search action auto-normalization (click -> type) passed!")

print("\nALL YOUTUBE SEARCH TESTS PASSED SUCCESSFULLY!")
