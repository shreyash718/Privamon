import sys
import json
import urllib.request

sys.stdout.reconfigure(encoding='utf-8')

from engine.server import get_presidio, get_gliner
from engine.normalizer import normalize_text
from engine.fusion_engine import fuse_detections

cases = {
    'A': 'Contact Number: 9876543210',
    'B': 'Order ID: 9876543210',
    'C': 'Invoice Number: 9876543210',
    'D': 'Riya Sharma',
    'E': '456 Green Park, New Delhi',
    'F': 'Customer Reference: ABX-92817'
}

p_det = get_presidio()
g_det = get_gliner()

for key, text in cases.items():
    print(f"==================================================")
    print(f"CASE {key}: \"{text}\"")
    print(f"==================================================")
    norm = normalize_text(text)
    norm_text = norm.normalized_text
    
    # 1. Presidio
    p_raw = p_det.detect(norm_text)
    p_mapped = []
    for d in p_raw:
        s, e = norm.map_span_to_original(d['start'], d['end'])
        p_mapped.append({**d, 'start': s, 'end': e, 'text': text[s:e]})
        
    # 2. GLiNER
    g_raw = g_det.detect(norm_text)
    g_mapped = []
    for d in g_raw:
        s, e = norm.map_span_to_original(d['start'], d['end'])
        g_mapped.append({**d, 'start': s, 'end': e, 'text': text[s:e]})
        
    # 3. Fusion
    raw_all = p_mapped + g_mapped
    fused, discarded = fuse_detections(raw_all, text)
    
    # 4. HTTP API verify
    req = urllib.request.Request(
        'http://127.0.0.1:8765/detect',
        data=json.dumps({"text": text, "source": "ocr"}).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )
    with urllib.request.urlopen(req) as resp:
        api_res = json.loads(resp.read().decode('utf-8'))
    
    print("Presidio raw detections:")
    print(json.dumps(p_mapped, indent=2))
    print("\nGLiNER raw detections:")
    print(json.dumps(g_mapped, indent=2))
    print("\nFinal fused result (from engine):")
    print(json.dumps(fused, indent=2))
    print("\nDiscard log:")
    print(json.dumps(discarded, indent=2))
    print(f"\nFinal API /detect response count: {len(api_res['detections'])}")
    
    final_conf = fused[0]['confidence'] if fused else None
    redact_decision = "REDACT" if len(fused) > 0 else "DON'T REDACT"
    print(f"Final confidence: {final_conf}")
    print(f"Final decision: {redact_decision}\n")
