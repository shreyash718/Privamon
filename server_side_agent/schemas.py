from pydantic import BaseModel, Field
from typing import Optional, Literal, Union, Any

ActionType = Literal[
    "click", "type", "scroll", "select", "wait", "ask_user", "done",
    "type_and_select", "pick_date", "select_custom", "fill_form"
]
ScrollDirection = Literal["up", "down"]

class RedactedRegion(BaseModel):
    bbox: list[int]
    reason: str

class ActionPayload(BaseModel):
    type: ActionType = "click"
    targetElementId: Optional[str] = None
    value: Optional[str] = None
    scrollDirection: Optional[ScrollDirection] = None
    fields: Optional[Any] = None

# Backward-compatibility alias
Action = ActionPayload

class InterpretRequest(BaseModel):
    task: str
    sanitizedScreenshot: Optional[str] = None
    image_b64: Optional[str] = None
    sanitizedDom: Optional[Union[list[dict[str, Any]], str]] = None
    sanitized_dom: Optional[str] = None
    detectionSummary: Optional[dict[str, Any]] = None
    redacted_regions: list[RedactedRegion] = []
    priorActions: list[str] = []
    conversationState: Optional[dict[str, Any]] = None

    def get_screenshot(self) -> str:
        return self.sanitizedScreenshot or self.image_b64 or ""

    def get_sanitized_dom(self) -> Union[list[dict[str, Any]], str]:
        if self.sanitizedDom is not None:
            return self.sanitizedDom
        return self.sanitized_dom or ""

    def get_detection_summary(self) -> dict[str, Any]:
        if self.detectionSummary is not None:
            return self.detectionSummary
        return {
            "total": len(self.redacted_regions),
            "byType": {r.reason: 1 for r in self.redacted_regions}
        }

class InterpretResponse(BaseModel):
    reasoning: str
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    action: ActionPayload
    assumptions: list[str] = Field(default_factory=list)
    needsClarification: bool = False

    # Backward compatibility helpers for UI components
    actions: list[dict[str, Any]] = Field(default_factory=list)
    message: Optional[str] = None
    thinking: Optional[str] = None
    raw_model_output: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    latency_ms: Optional[float] = None