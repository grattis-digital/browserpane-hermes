"""Read-only gateway-process health; not a claim that an LLM/channel is configured."""

from functools import lru_cache
import importlib.util
import sys


@lru_cache(maxsize=1)
def load_status():
    # The pinned status helper is import-light, but gateway/__init__.py eagerly
    # loads the messaging stack. Load the unmodified helper under a private name
    # in this short-lived probe only; retain upstream PID/lock/profile validation.
    name = "_browserpane_gateway_health_status"
    spec = importlib.util.spec_from_file_location(name, "/opt/hermes/gateway/status.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module  # Dataclass/typing metadata needs a registered module.
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def healthy() -> bool:
    status = load_status()
    state = status.read_runtime_status() or {}
    return state.get("gateway_state") in {"running", "degraded"} and status.get_running_pid(cleanup_stale=False) is not None


if __name__ == "__main__":
    sys.exit(0 if healthy() else 1)
