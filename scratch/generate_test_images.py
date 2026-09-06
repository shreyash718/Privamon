"""
Generates synthetic test images for Privamon End-to-End Image Sanitization Pipeline:
1. scratch/competing_identifiers.png:
   Name: Riya Sharma
   Mobile: 9876543210
   Order ID: 9876543210
   Employee ID: XJ729184
   Product ID: XJ729184
   Email: riya@example.com
   Address: 456 Green Park, New Delhi

2. scratch/hindi_english.png:
   नाम - मिश्र जी
   पता - सेक्टर 11, फरीदाबाद
   मोबाइल - 90262 58983
"""

import os
from PIL import Image, ImageDraw, ImageFont

os.makedirs("scratch", exist_ok=True)

def generate_competing_identifiers_image():
    w, h = 700, 360
    img = Image.new("RGB", (w, h), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)

    lines = [
        ("Name: Riya Sharma", 30, 30),
        ("Mobile: 9876543210", 30, 75),
        ("Order ID: 9876543210", 30, 120),
        ("Employee ID: XJ729184", 30, 165),
        ("Product ID: XJ729184", 30, 210),
        ("Email: riya@example.com", 30, 255),
        ("Address: 456 Green Park, New Delhi", 30, 300),
    ]

    try:
        font = ImageFont.truetype("arial.ttf", 22)
    except Exception:
        font = ImageFont.load_default()

    for text, x, y in lines:
        draw.text((x, y), text, fill=(0, 0, 0), font=font)

    path = "scratch/competing_identifiers.png"
    img.save(path)
    print(f"[Generated] {path} ({w}x{h})")
    return path


def generate_hindi_english_image():
    w, h = 600, 200
    img = Image.new("RGB", (w, h), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)

    lines = [
        ("नाम - मिश्र जी", 30, 30),
        ("पता - सेक्टर 11, फरीदाबाद", 30, 80),
        ("मोबाइल - 90262 58983", 30, 130),
    ]

    # Try Windows Nirmala UI font collection for Hindi
    font = None
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/Nirmala.ttc", 28, index=0)
    except Exception as e:
        print("Warning: could not load Nirmala.ttc:", e)
        font = ImageFont.load_default()

    for text, x, y in lines:
        draw.text((x, y), text, fill=(0, 0, 0), font=font)

    path = "scratch/hindi_english.png"
    img.save(path)
    print(f"[Generated] {path} ({w}x{h})")
    return path

if __name__ == "__main__":
    generate_competing_identifiers_image()
    generate_hindi_english_image()
