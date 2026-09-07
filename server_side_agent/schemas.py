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
    type: Optional[str] = "click"
    target_bbox: Optional[list[int]] = None
    value: Optional[str] = None
    reasoning: Optional[str] = None
    description: Optional[str] = None
    target: Optional[str] = None

class InterpretResponse(BaseModel):
    actions: list[Action] = []
    raw_model_output: str
    thinking: Optional[str] = None
    message: Optional[str] = None