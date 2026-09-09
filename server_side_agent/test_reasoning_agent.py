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

# Test 6: Search query auto-normalization from click on search bar to type
from model_client import extract_search_query, _normalize_search_action
q1 = extract_search_query("search Indias got latent and play most viewed video")
assert q1 == "Indias got latent", f"Query extraction failed: {q1}"
q2 = extract_search_query('On this site search "Khat" and play first video that appears')
assert q2 == "Khat", f"Query extraction failed: {q2}"

# Simulate model returning click on search bar for search task
t6 = '{"reasoning": "To search for \'Indias got latent\', I need to click on the search bar to enter the query.", "confidence": 0.95, "action": {"type": "click", "targetElementId": "dom-tok-18", "value": null, "scrollDirection": null}, "assumptions": ["Search bar active"], "needsClarification": false}'
v6, _ = parse_and_validate(t6)
sanitized_dom_mock = [{"elementId": "dom-tok-18", "tag": "input", "id": "search", "placeholder": "Search", "role": "combobox"}]
v6_norm = _normalize_search_action(v6, "search Indias got latent and play most viewed video", sanitized_dom_mock)
assert v6_norm.action.type == "type", f"Search action normalization failed: {v6_norm.action.type}"
assert v6_norm.action.value == "Indias got latent", f"Search query value failed: {v6_norm.action.value}"
assert v6_norm.action.targetElementId == "dom-tok-18"
print("✓ Test 6 (Search query extraction and click-to-type search normalization) passed")

# Test 7: Clicks on search submit buttons and video/product links MUST remain click (never converted to type)
t7_btn = '{"reasoning": "The search input is populated with \'watches\', and the search button (Search Icon) is the primary action to trigger the search.", "confidence": 0.95, "action": {"type": "click", "targetElementId": "dom-tok-68", "value": null, "scrollDirection": null}, "assumptions": ["Search button active"], "needsClarification": false}'
v7_btn, _ = parse_and_validate(t7_btn)
sanitized_dom_btn = [{"elementId": "dom-tok-68", "tag": "button", "role": "button", "label": "Search"}]
v7_btn_norm = _normalize_search_action(v7_btn, "search watches on flipkart", sanitized_dom_btn)
assert v7_btn_norm.action.type == "click", f"Button click was erroneously converted to {v7_btn_norm.action.type}"
assert v7_btn_norm.action.targetElementId == "dom-tok-68"

t7_video = '{"reasoning": "Clicking the first video result for the search query to play it.", "confidence": 0.95, "action": {"type": "click", "targetElementId": "dom-tok-video", "value": null, "scrollDirection": null}, "assumptions": [], "needsClarification": false}'
v7_video, _ = parse_and_validate(t7_video)
sanitized_dom_video = [{"elementId": "dom-tok-video", "tag": "a", "role": "link", "id": "video-title", "label": "Recommended Video"}]
v7_video_norm = _normalize_search_action(v7_video, "search something and play the first recommended video", sanitized_dom_video)
assert v7_video_norm.action.type == "click", f"Video link click was erroneously converted to {v7_video_norm.action.type}"
assert v7_video_norm.action.targetElementId == "dom-tok-video"
print("✓ Test 7 (Search button and video link clicks are preserved as clicks) passed")

# Test 8: Platform-specific search query extraction (Flipkart, Amazon, etc.)
q3 = extract_search_query("search watches on flipkart")
assert q3 == "watches", f"Flipkart query extraction failed: {q3}"
q4 = extract_search_query("search iphone 15 on amazon")
assert q4 == "iphone 15", f"Amazon query extraction failed: {q4}"
q5 = extract_search_query("search stylish watches for me")
assert q5 == "stylish watches", f"'for me' query extraction failed: {q5}"
print("✓ Test 8 (E-commerce platform query extraction) passed")

# Test 9: Flipkart search with empty input and click on search button -> normalized to type on search input
t9_flipkart_btn = '{"reasoning": "Clicking search icon to find stylish watches.", "confidence": 0.95, "action": {"type": "click", "targetElementId": "dom-tok-68", "value": null, "scrollDirection": null}, "assumptions": [], "needsClarification": false}'
v9, _ = parse_and_validate(t9_flipkart_btn)
sanitized_dom_flipkart = [
    {"elementId": "dom-tok-68", "tag": "button", "role": "button", "label": "Search for Products, Brands and More"},
    {"elementId": "dom-tok-70", "tag": "input", "placeholder": "Search for Products, Brands and More", "value": ""}
]
v9_norm = _normalize_search_action(v9, "search stylish watches for me", sanitized_dom_flipkart)
assert v9_norm.action.type == "type", f"Expected 'type', got {v9_norm.action.type}"
assert v9_norm.action.targetElementId == "dom-tok-70", f"Expected target 'dom-tok-70', got {v9_norm.action.targetElementId}"
assert v9_norm.action.value == "stylish watches", f"Expected value 'stylish watches', got {v9_norm.action.value}"
print("✓ Test 9 (Flipkart empty input search button click auto-converted to type) passed")

# Test 10: Intercept premature 'done' on homepage with empty search input
t10_done = '{"reasoning": "The search for stylish watches has been executed. Task complete.", "confidence": 0.95, "action": {"type": "done", "targetElementId": null, "value": null, "scrollDirection": null}, "assumptions": [], "needsClarification": false}'
v10, _ = parse_and_validate(t10_done)
v10_norm = _normalize_search_action(v10, "search stylish watches for me", sanitized_dom_flipkart)
assert v10_norm.action.type == "type", f"Expected 'type' for premature done, got {v10_norm.action.type}"
assert v10_norm.action.targetElementId == "dom-tok-70", f"Expected target 'dom-tok-70', got {v10_norm.action.targetElementId}"
assert v10_norm.action.value == "stylish watches", f"Expected value 'stylish watches', got {v10_norm.action.value}"
# Test 11: Step 2 verification with stepGuidance in task does not leak into query and preserves 'done' action
t11_task = 'search stylish watches for me [STEP GUIDANCE: The previous action (type "stylish watches") was executed. Inspect the screen: If search results or product listings are displayed, the search succeeded! Return action type "done" unless the user asked to click or open a specific item.]'
q11 = extract_search_query(t11_task)
assert q11 == "stylish watches", f"Step guidance leaked into search query: {q11}"

t11_done = '{"reasoning": "Search results are displayed as product listings with prices and images. Task complete.", "confidence": 0.95, "action": {"type": "done", "targetElementId": null, "value": null, "scrollDirection": null}, "assumptions": ["Search results are displayed"], "needsClarification": false}'
v11, _ = parse_and_validate(t11_done)
sanitized_dom_results = [
    {"elementId": "dom-tok-17", "tag": "input", "placeholder": "Search for Products, Brands and More", "value": "stylish watches"}
]
prior_acts = ['type dom-tok-70 "stylish watches" [outcome: executed_and_sent]']
v11_norm = _normalize_search_action(v11, t11_task, sanitized_dom_results, prior_actions=prior_acts)
assert v11_norm.action.type == "done", f"Expected 'done' on verified search results, but got: {v11_norm.action.type} with value {v11_norm.action.value}"
print("✓ Test 11 (Step guidance clean stripping and search completion preservation) passed")

# Test 12: YouTube playlist, course, and sidebar rejection in is_result_item
from model_client import is_result_item
sidebar_playlist = {"elementId": "dom-tok-12", "tag": "a", "label": "Playlists", "bbox": {"x": 40, "y": 300}, "isSidebar": True}
assert not is_result_item(sidebar_playlist), "Sidebar 'Playlists' link should be rejected"

course_card = {"elementId": "dom-tok-45", "tag": "a", "label": "Gate Smashers • Course • 55 lessons", "text": "Machine Learning", "href": "/playlist?list=PLxCzCOWd7aiFM9Km5713Qv"}
assert is_result_item(course_card), "Course card with playlist href should be recognized as result item"

playlist_card = {"elementId": "dom-tok-55", "tag": "a", "label": "Stanford Online • Playlist • 21 videos", "text": "Stanford CS229: Machine Learning", "href": "/playlist?list=PLoROMvodv4rMiGQp3WXShtMGgqVgdElU_"}
assert is_result_item(playlist_card), "Playlist card with 21 videos should be recognized as result item"
print("✓ Test 12 (YouTube playlist and course detection in is_result_item) passed")

# Test 13: Premature 'done' converted to 'click' on first playlist/course in compound search+play task
t13_task = "search machine learning lecture for me and play it"
t13_done = '{"reasoning": "Search results for machine learning lecture are displayed. Task complete.", "confidence": 0.95, "action": {"type": "done", "targetElementId": null, "value": null, "scrollDirection": null}, "assumptions": [], "needsClarification": false}'
v13, _ = parse_and_validate(t13_done)
sanitized_dom_yt = [
    sidebar_playlist,
    {"elementId": "dom-tok-18", "tag": "input", "id": "search", "value": "machine learning lecture"},
    course_card,
    playlist_card
]
prior_acts_yt = ['type dom-tok-18 "machine learning lecture" [outcome: executed_and_sent]']
v13_norm = _normalize_search_action(v13, t13_task, sanitized_dom_yt, prior_actions=prior_acts_yt)
assert v13_norm.action.type == "click", f"Expected 'click' on playlist result, got {v13_norm.action.type}"
print("✓ Test 13 (Premature 'done' auto-converted to click on first playlist/course result) passed")

# Test 14: WhatsApp message extraction and duplicate send prevention
from model_client import extract_message_text, _normalize_action
msg_task = "draft and send him message that I will not be available for tommorows meeting"
extracted_msg = extract_message_text(msg_task)
assert extracted_msg == "I will not be available for tommorows meeting", f"Failed to extract message: {extracted_msg}"

t14_step2 = '{"reasoning": "The message is already typed and visible in the chat history, indicating the task is complete.", "confidence": 0.95, "action": {"type": "type", "targetElementId": "dom-tok-725", "value": null, "scrollDirection": null}, "assumptions": [], "needsClarification": false}'
v14, _ = parse_and_validate(t14_step2)
prior_acts_msg = ['type dom-tok-703 "I will not be available for tommorows meeting" [outcome: executed_and_sent]']
sanitized_dom_chat = [{"elementId": "dom-tok-725", "tag": "div", "role": "textbox", "placeholder": "Type a message"}]
v14_norm = _normalize_action(v14, msg_task, sanitized_dom_chat, prior_actions=prior_acts_msg)
assert v14_norm.action.type == "done", f"Expected 'done' for already sent message, got {v14_norm.action.type}"
print("✓ Test 14 (WhatsApp message extraction and duplicate send prevention) passed")

# Test 15: Contact task parsing and creative generation detection
import json
from model_client import parse_contact_task, is_creative_generation_task, is_contact_result_item

c1, b1 = parse_contact_task("message Tanishq I will be not availablle for tommorow")
assert c1 == "Tanishq" and b1 == "I will be not availablle for tommorow", f"Failed: {c1}, {b1}"

c2, b2 = parse_contact_task("search for contact Tanishq and message him that I will not be avilable for tommorows meeting")
assert c2 == "Tanishq" and b2 == "I will not be avilable for tommorows meeting", f"Failed: {c2}, {b2}"

c3, b3 = parse_contact_task('send "Tanishq" a beatifull 10 line poem')
assert c3 == "Tanishq" and b3 == "beatifull 10 line poem", f"Failed: {c3}, {b3}"

c4, b4 = parse_contact_task("tell Parth Bhaiya that meeting is cancelled")
assert c4 == "Parth Bhaiya" and b4 == "meeting is cancelled", f"Failed: {c4}, {b4}"

assert is_creative_generation_task('send "Tanishq" a beatifull 10 line poem')
assert is_creative_generation_task("type atleast 10 lines of poetry")
assert not is_creative_generation_task("message Tanishq I will be not availablle for tommorow")
print("✓ Test 15 (Contact task parsing & creative generation detection) passed")

# Test 16: Creative poem preservation vs literal message extraction in _normalize_action
poem_10_lines = (
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
creative_json = json.dumps({
    "reasoning": "Generated a 10-line poem for Tanishq.",
    "confidence": 0.95,
    "action": {"type": "type", "targetElementId": "dom-tok-745", "value": poem_10_lines, "scrollDirection": None},
    "assumptions": ["Chat is open"],
    "needsClarification": False
})
v16_creative, _ = parse_and_validate(creative_json)
sanitized_dom_open_chat = [{"elementId": "dom-tok-745", "tag": "div", "role": "textbox", "placeholder": "Type a message", "bbox": {"x": 600, "y": 700}}]
v16_norm = _normalize_action(v16_creative, 'send "Tanishq" a beatifull 10 line poem', sanitized_dom_open_chat, prior_actions=['click dom-tok-402 "Tanishq"'])
assert v16_norm.action.value == poem_10_lines, "Creative poem in action.value was modified or overwritten!"
assert len(v16_norm.action.value.split('\n')) == 10, "Expected 10 lines in generated poem"

# Literal message test
literal_json = json.dumps({
    "reasoning": "Sending exact message to Tanishq.",
    "confidence": 0.95,
    "action": {"type": "click", "targetElementId": "dom-tok-745", "value": None, "scrollDirection": None},
    "assumptions": ["Chat is open"],
    "needsClarification": False
})
v16_literal, _ = parse_and_validate(literal_json)
v16_lit_norm = _normalize_action(v16_literal, "message Tanishq I will be not availablle for tommorow", sanitized_dom_open_chat, prior_actions=['click dom-tok-402 "Tanishq"'])
assert v16_lit_norm.action.type == "type"
assert v16_lit_norm.action.value == "I will be not availablle for tommorow"
print("✓ Test 16 (Preservation of generated poem vs literal message extraction) passed")

# Test 17: Multi-step WhatsApp contact workflow normalization (Step 1 search -> Step 2 click contact)
dom_whatsapp_step1 = [
    {"elementId": "dom-tok-10", "tag": "div", "role": "textbox", "placeholder": "Search or start new chat", "bbox": {"x": 100, "y": 80}},
    {"elementId": "dom-tok-745", "tag": "div", "role": "textbox", "placeholder": "Type a message", "bbox": {"x": 600, "y": 700}}
]
t17_step1_raw = json.dumps({
    "reasoning": "Typing message directly.",
    "confidence": 0.8,
    "action": {"type": "click", "targetElementId": "dom-tok-10", "value": None, "scrollDirection": None},
    "assumptions": [],
    "needsClarification": False
})
v17_step1, _ = parse_and_validate(t17_step1_raw)
v17_step1_norm = _normalize_action(v17_step1, "message Tanishq I will be not availablle for tommorow", dom_whatsapp_step1, prior_actions=[])
assert v17_step1_norm.action.type == "type"
assert v17_step1_norm.action.targetElementId == "dom-tok-10"
assert v17_step1_norm.action.value == "Tanishq"

# Step 2: Contact searched in prior turn; model selects top contact result under Chats
dom_whatsapp_step2 = [
    {"elementId": "dom-tok-10", "tag": "div", "role": "textbox", "placeholder": "Search or start new chat", "value": "Tanishq", "bbox": {"x": 100, "y": 80}},
    {"elementId": "dom-tok-402", "tag": "div", "role": "listitem", "label": "Tanishq", "text": "Tanishq", "bbox": {"x": 150, "y": 120}},
    {"elementId": "dom-tok-745", "tag": "div", "role": "textbox", "placeholder": "Type a message", "bbox": {"x": 600, "y": 700}}
]
t17_step2_raw = json.dumps({
    "reasoning": "Typing message in chat window.",
    "confidence": 0.8,
    "action": {"type": "type", "targetElementId": "dom-tok-745", "value": "I will be not availablle for tommorow", "scrollDirection": None},
    "assumptions": [],
    "needsClarification": False
})
v17_step2, _ = parse_and_validate(t17_step2_raw)
v17_step2_norm = _normalize_action(v17_step2, "message Tanishq I will be not availablle for tommorow", dom_whatsapp_step2, prior_actions=['type dom-tok-10 "Tanishq" [outcome: executed]'])
assert v17_step2_norm.action.type == "click"
assert v17_step2_norm.action.targetElementId == "dom-tok-402"
print("✓ Test 17 (Multi-step WhatsApp contact workflow normalization) passed")

# Test 18: Prompt echo detection and automatic poem composition for creative tasks
from model_client import is_prompt_echo, compose_creative_fallback

t18_task = "10 line poem on love"
assert is_prompt_echo("10 line poem on love", t18_task) == True
assert is_prompt_echo("Love is a quiet flame\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10", t18_task) == False

echo_resp_json = json.dumps({
    "reasoning": "Sending 10 line poem on love.",
    "confidence": 0.85,
    "action": {"type": "type", "targetElementId": "dom-tok-745", "value": "10 line poem on love", "scrollDirection": None},
    "assumptions": [],
    "needsClarification": False
})
v18, _ = parse_and_validate(echo_resp_json)
sanitized_dom_18 = [{"elementId": "dom-tok-745", "tag": "div", "role": "textbox", "placeholder": "Type a message", "bbox": {"x": 600, "y": 700}}]
v18_norm = _normalize_action(v18, t18_task, sanitized_dom_18, prior_actions=[])
assert v18_norm.action.value != "10 line poem on love", f"Prompt echo was not replaced! {v18_norm.action.value}"
assert len(v18_norm.action.value.split("\n")) >= 8, f"Expected full poem, got: {v18_norm.action.value}"
print("✓ Test 18 (Prompt echo detection and automatic poem composition) passed")

# Test 19: Marriage greeting message drafting and echo replacement
t19_task = 'send "shivam" greeting message for his marriage'

# 1. Must be recognized as creative generation task
assert is_creative_generation_task(t19_task) == True, "Failed to identify marriage greeting as creative task"

# 2. Must not extract literal instruction as literal message body
extracted_19 = extract_message_text(t19_task)
assert extracted_19 is None, f"Expected None for creative task, got literal extract: {extracted_19}"

# 3. Echo check: 'greeting message for his marriage' or 'greeting message' must be detected as echo
assert is_prompt_echo("greeting message for his marriage", t19_task) == True, "Failed to detect exact instruction echo"
assert is_prompt_echo("greeting message", t19_task) == True, "Failed to detect partial echo"
assert is_prompt_echo("", t19_task) == True, "Failed to detect empty value"

# 4. Valid composed wedding message should NOT be flagged as echo
good_wedding_msg = "Heartiest congratulations on your wedding, Shivam! Wishing you and your partner a lifetime of love and happiness together!"
assert is_prompt_echo(good_wedding_msg, t19_task) == False, "Mistakenly flagged good message as echo"

# 5. Normalization test: If model emits prompt echo 'greeting message for his marriage', auto-compose replaces it with warm greeting
sanitized_dom_19 = [{"elementId": "dom-tok-745", "tag": "div", "role": "textbox", "placeholder": "Type a message", "bbox": {"x": 600, "y": 700}}]
echo_resp_19_json = json.dumps({
    "reasoning": "Typing greeting message for his marriage into message box.",
    "confidence": 0.9,
    "action": {"type": "type", "targetElementId": "dom-tok-745", "value": "greeting message for his marriage", "scrollDirection": None},
    "assumptions": [],
    "needsClarification": False
})
v19, _ = parse_and_validate(echo_resp_19_json)
v19_norm = _normalize_action(v19, t19_task, sanitized_dom_19, prior_actions=['click dom-tok-402 "Shivam"'])
assert v19_norm.action.value != "greeting message for his marriage", f"Echo was not replaced: {v19_norm.action.value}"
assert "greeting message for his marriage" not in v19_norm.action.value.lower(), f"Echo substring remained: {v19_norm.action.value}"
assert any(w in v19_norm.action.value.lower() for w in ("congratulat", "wedding", "marriage", "happiness", "joy", "love")), f"Composed message lacked wedding greeting sentiment: {v19_norm.action.value}"
print("✓ Test 19 (Marriage greeting drafting and echo replacement) passed")

# Test 20: Polite message drafting & cross-task prior action isolation
from model_client import is_valid_contact_name
t20_task = 'send "shivam" message that I will not able to attend his lecture tommorow be polite'
c20, b20 = parse_contact_task(t20_task)
assert c20 == "shivam", f"Expected shivam, got {c20}"
assert is_valid_contact_name("that") == False, "'that' should not be valid contact name"
assert is_creative_generation_task(t20_task) == True, "'be polite' should trigger creative drafting"

sanitized_dom_20 = [
    {"elementId": "dom-tok-10", "tag": "div", "role": "textbox", "placeholder": "Search or start new chat", "bbox": {"x": 100, "y": 80}},
    {"elementId": "dom-tok-100", "tag": "div", "role": "button", "label": "Shivam 31 Oct", "text": "Shivam 31 Oct", "bbox": {"x": 400, "y": 60}},
    {"elementId": "dom-tok-579", "tag": "div", "role": "textbox", "placeholder": "Type a message", "bbox": {"x": 600, "y": 700}}
]

# Prior action from previous unrelated task (marriage greeting)
prior_20 = [
    'type dom-tok-745 "greeting message for his marriage" [outcome: executed_and_sent]',
    'click dom-tok-289 [outcome: clicked_successfully]'
]

model_resp_20_json = json.dumps({
    "reasoning": "The task requires sending a polite message to Shivam about not attending his lecture. The bottom-right textbox (elementId: 'dom-tok-579') is designated input area for typing messages in this chat interface.",
    "confidence": 0.95,
    "action": {
        "type": "type",
        "targetElementId": "dom-tok-579",
        "value": "Hi Shivam, I will not be able to attend your lecture tomorrow. Apologies for the inconvenience.",
        "scrollDirection": None
    },
    "assumptions": [],
    "needsClarification": False
})
v20, _ = parse_and_validate(model_resp_20_json)
v20_norm = _normalize_action(v20, t20_task, sanitized_dom_20, prior_actions=prior_20)

assert v20_norm.action.type == "type", f"Expected 'type', got {v20_norm.action.type} (was falsely converted to done!)"
assert v20_norm.action.targetElementId == "dom-tok-579", f"Target should be message box dom-tok-579, got {v20_norm.action.targetElementId}"
assert v20_norm.action.value is not None, "Message value should not be None"
assert any(w in v20_norm.action.value.lower() for w in ("lecture", "attend", "apolog", "tomorrow")), f"Value lacked lecture message content: {v20_norm.action.value}"
print("✓ Test 20 (Polite message drafting & cross-task prior action isolation) passed")

print("\nAll 20 reasoning agent validation tests PASSED!")




