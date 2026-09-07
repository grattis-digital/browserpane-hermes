"""Hermes observer adapter. No model, browser, or network calls."""

import json
import logging

from .contracts import CaptureError, command
from .draft import DraftBuilder
from .projection import EventProjection


class CaptureController:
    def __init__(self, store):
        self._store = store
        self._observer_error = False

    def handle(self, args, session_id=None, task_id=None, **_kwargs):
        try:
            args = command(args)
            if args["op"] == "forget":
                self._store.forget(session_id, task_id, args["run_id"])
                return json.dumps({"forgotten": args["run_id"], "recoverable": "Only from a separate backup"})
            if args["op"] == "start":
                run_id = self._store.start(session_id, task_id, args.get("ttl_minutes", 10))
                run = self._store.read(session_id, task_id, run_id)
            else:
                run = self._store.read(session_id, task_id, args.get("run_id"), finish=args["op"] == "finish")
            result = DraftBuilder.summary(run)
            result["observer_error_seen_in_process"] = self._observer_error
            if args["op"] == "finish":
                result["draft"] = DraftBuilder.build(run)
                result["next"] = "Review browserpane-workflows:author, then /learn or skill_manage. This scaffold has unresolved targets/parameters and does not establish business success."
            if args["op"] == "read":
                offset = args.get("offset", 0)
                result["events"] = run["events"][offset:offset + 16]
                if offset + 16 < len(run["events"]):
                    result["next_offset"] = offset + 16
            return json.dumps(result, allow_nan=False)
        except CaptureError as exc:
            return json.dumps({"error": exc.code})
        except Exception:
            # Never reflect raw paths, payloads, SQLite errors or provider messages.
            return json.dumps({"error": "CAPTURE_STORAGE_ERROR"})

    def _record(self, payload, project, id_key, prefix):
        try:
            event = project(payload)
            if event is not None:
                event_id = payload.get(id_key)
                if not isinstance(event_id, str) or not event_id:
                    raise CaptureError("MISSING_EVENT_ID")
                self._store.append(payload.get("session_id"), payload.get("task_id"), prefix + event_id, event)
        except Exception:
            self._observer_error = True
            logging.getLogger(__name__).warning("Workflow capture omitted an event; evidence remains unverified.")

    def on_tool(self, **payload):
        self._record(payload, EventProjection.tool, "tool_call_id", "tool:")

    def on_usage(self, **payload):
        self._record(payload, EventProjection.usage, "api_request_id", "usage:")
