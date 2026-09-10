"""Pinned Hermes MCP SDK adapter; no alternative browser automation backend."""

from contextlib import asynccontextmanager
import json
import time

from .contracts import WorkflowError, require
from .mcp_failure import CompactFailure


class CompactClient:
    def __init__(self, session, clock):
        self._session, self._clock = session, clock
        self._calls, self._bytes, self._ms = 0, 0, 0.0
        self._request, self.healthy = 0, True

    def next_request(self):
        self._request += 1
        return self._request

    @classmethod
    @asynccontextmanager
    async def connect(cls, endpoint):
        # Imports are lazy: offline review/status/unit tests do not need the SDK.
        import importlib.metadata
        import httpx2
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
        require(importlib.metadata.version("mcp") == "2.0.0", "UNQUALIFIED_MCP_SDK")
        async with httpx2.AsyncClient(trust_env=False, follow_redirects=False, timeout=20) as http:
            async with streamable_http_client(endpoint, http_client=http) as (read, write):
                async with ClientSession(read, write, read_timeout_seconds=20) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    flow = next((tool for tool in tools.tools if tool.name == "pane_flow"), None)
                    require(flow is not None and "view" in flow.input_schema.get("properties", {}), "GUARDED_FLOW_REQUIRED")
                    yield cls(session, time.monotonic)

    async def call(self, name, args):
        require(name in ("pane_view", "pane_act", "pane_flow"), "TOOL_NOT_ALLOWED")
        start = self._clock()
        self._calls += 1
        try:
            reply = await self._session.call_tool(name, args, read_timeout_seconds=20)
            require(getattr(reply, "result_type", None) == "complete", "MCP_ACTION_FAILED")
            content = getattr(reply, "content", None)
            require(content and len(content) == 1 and content[0].type == "text", "INVALID_MCP_REPLY")
            raw = content[0].text
            require(len(raw.encode("utf-8")) <= 65536, "MCP_REPLY_LIMIT")
            self._bytes += len(json.dumps(reply.model_dump(mode="json", by_alias=True, exclude_unset=True, exclude_none=True), separators=(",", ":"), ensure_ascii=False).encode())
            value = json.loads(raw)
            require(type(value) is dict and type(value.get("v")) is int and value["v"] == 1, "INVALID_MCP_REPLY")
            if getattr(reply, "is_error", None) is not False or value.get("error") or value.get("observationError"):
                raise CompactFailure(value)
            return value
        except WorkflowError:
            self.healthy = False
            raise
        except Exception as exc:
            self.healthy = False
            raise WorkflowError("MCP_UNCERTAIN") from exc
        finally:
            self._ms += (self._clock() - start) * 1000

    def metrics(self):
        return {"mcpCalls": self._calls, "responseJsonBytes": self._bytes, "mcpMs": self._ms}
