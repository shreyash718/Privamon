import urllib.request
import os

url = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
dest = "lib/onnx/yunet.onnx"

print(f"[*] Downloading YuNet ONNX model from {url}...")
try:
    urllib.request.urlretrieve(url, dest)
    size = os.path.getsize(dest)
    print(f"[✓] Successfully downloaded YuNet ONNX model: {dest} ({size / 1024:.1f} KB)")
except Exception as e:
    print(f"[X] Download failed: {e}")
