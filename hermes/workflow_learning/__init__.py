"""Opt-in Hermes plugin entrypoint; importing does not record or create files."""

from pathlib import Path
import time


def register(ctx):
    from hermes_constants import get_hermes_home
    from .capture import CaptureController
    from .contracts import SCHEMA
    from .store import CaptureStore

    controller = CaptureController(CaptureStore(get_hermes_home(), time.time))
    ctx.register_tool(name="workflow_capture", toolset="workflow_learning", schema=SCHEMA,
                      handler=controller.handle, description="Opt-in browser workflow learning")
    ctx.register_hook("post_tool_call", controller.on_tool)
    ctx.register_hook("post_api_request", controller.on_usage)
    ctx.register_skill("author", Path(__file__).with_name("SKILL.md"),
                       description="Learn verified, parameterized browser procedures")
    ctx.register_system_prompt_section("browserpane-workflow-learning",
        "Browser workflow learning is optional. Only when the user asks to record or learn a run, "
        "load skill_view(name='browserpane-workflows:author'). workflow_capture is a local learning "
        "record, not a browser executor, success verifier or approval system. Never auto-start recording.", max_chars=500)
