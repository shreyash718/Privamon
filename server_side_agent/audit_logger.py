import json, os, time
from datetime import datetime, timezone
from typing import Any

LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audit_log.jsonl")

def log_turn(
    task: str,
    action: dict[str, Any],
    confidence: float,
    assumptions: list[str],
    needs_clarification: bool,
    reasoning: str,
    latency_ms: float,
    retried: bool = False
) -> None:
    """
    Appends a turn record to audit_log.jsonl for evaluation auditability,
    and logs a concise summary to stdout.
    """
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "task": task,
        "confidence": round(confidence, 3),
        "action": action,
        "assumptions": assumptions,
        "needsClarification": needs_clarification,
        "reasoning": reasoning,
        "latencyMs": latency_ms,
        "retried": retried
    }

    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception as e:
        print(f"[!] Warning: Failed to write to audit log: {e}")

    # Colorized terminal output for instant developer/evaluator observability
    action_type = action.get("type", "unknown").upper()
    target = action.get("targetElementId") or action.get("value") or "-"
    conf_color = "\033[92m" if confidence >= 0.7 else ("\033[93m" if confidence >= 0.5 else "\033[91m")
    reset = "\033[0m"
    retry_flag = " [RETRIED]" if retried else ""

    print(
        f"\n\033[94m[AUDIT]\033[0m Action: \033[1m{action_type}\033[0m ({target}) | "
        f"Conf: {conf_color}{confidence:.2f}{reset} | "
        f"Latency: \033[96m{latency_ms:.0f}ms\033[0m{retry_flag} | "
        f"Assumptions: {len(assumptions)} | "
        f"Clarify: {needs_clarification}"
    )
    if assumptions:
        print(f"        \033[90mAssumptions: {assumptions}\033[0m")
