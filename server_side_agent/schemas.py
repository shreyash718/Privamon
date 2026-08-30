from pydantic import BaseModel
from typing import Optional, Literal

class RedactedRegion(BaseModel):
    bbox: list[int]
    reason: str

class InterpretRequest(BaseModel):
    image_b64: str
    redacted_regions: list[RedactedRegion] = []
    task: str
    sanitized_dom: str = ""

class Action(BaseModel):
    type: Literal["click", "type", "scroll", "wait", "done"]
    target_bbox: Optional[list[int]] = None
    value: Optional[str] = None
    reasoning: Optional[str] = None

class InterpretResponse(BaseModel):
    actions: list[Action]
    raw_model_output: str