"""Read-only gateway-process health; not a claim that an LLM/channel is configured."""

import sys

from gateway.status import get_running_pid, read_runtime_status


def healthy() -> bool:
    state = read_runtime_status() or {}
    return state.get("gateway_state") in {"running", "degraded"} and get_running_pid(cleanup_stale=False) is not None


if __name__ == "__main__":
    sys.exit(0 if healthy() else 1)
