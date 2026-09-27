import onnx
from onnxsim import simplify

def inspect_and_simplify(model_path, output_path):
    print(f"\n========================================")
    print(f"[*] Processing ONNX Model: {model_path}")
    model = onnx.load(model_path)
    print(f"IR Version: {model.ir_version}")
    print(f"Producer: {model.producer_name} v{model.producer_version}")
    opsets = {op.domain or 'ai.onnx': op.version for op in model.opset_import}
    print(f"Opset Imports: {opsets}")

    print("[*] Running onnx-simplifier (onnxsim)...")
    model_simp, check = simplify(model)
    if check:
        print("[✓] onnxsim simplification SUCCESSFUL!")
        onnx.save(model_simp, output_path)
        print(f"[✓] Saved simplified model to {output_path}")
    else:
        print("[X] onnxsim simplification check failed!")

if __name__ == "__main__":
    inspect_and_simplify("lib/onnx/version-RFB-320-clean.onnx", "lib/onnx/version-RFB-320-simplified.onnx")
    inspect_and_simplify("lib/onnx/blazeface.onnx", "lib/onnx/blazeface-simplified.onnx")
