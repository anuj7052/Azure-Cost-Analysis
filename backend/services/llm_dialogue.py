"""
One conversation, spoken over whichever API the model actually supports.

Azure's newer reasoning deployments -- the ``-pro`` family among them -- do not
implement Chat Completions at all. They advertise ``chat_completion: false``
and answer any attempt with a flat *"The requested operation is unsupported."*
Those models speak the Responses API instead, which is not a dialect of Chat
Completions but a different shape: the transcript is a list of items rather
than messages, tool schemas are flat rather than nested, and a tool result is
an item referring back to a call id rather than a message with a role.

Rather than teach both assistants two protocols, this module owns the
transcript in a neutral form and renders it for whichever protocol the
endpoint turns out to want. Callers see messages and tool calls; they never
see the difference.

Which protocol is discovered rather than configured. Asking the customer to
know that their deployment is Responses-only would be asking them to know
something the deployment can be asked directly -- so the first call tries Chat
Completions, and if the endpoint says that operation is unsupported, the same
turn is replayed over Responses and the answer is remembered for the life of
the process. If the second attempt fails too, the *first* error is raised,
because that is the one that describes what the customer set up.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

CHAT = "chat"
RESPONSES = "responses"

# Phrases an endpoint uses when it has the deployment but not the operation.
# Deliberately narrow: a wrong deployment name must keep reading as a wrong
# deployment name, not be quietly retried into a second confusing failure.
_UNSUPPORTED_HINTS = (
    "requested operation is unsupported",
    "unsupported operation",
    "not supported with this model",
    "does not support",
    "unsupported_value",
)

# Remembering the protocol per endpoint+model keeps the cost of discovery to
# one wasted call per process, not one per turn.
_PROTOCOL: Dict[str, str] = {}


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class Turn:
    """What the model did this step: said something, or asked for tools."""

    text: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)


def _looks_unsupported(exc: Exception) -> bool:
    status = getattr(exc, "status_code", None)
    if status not in (400, 404, 405):
        return False
    body = getattr(exc, "body", None)
    message = ""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "")
        elif isinstance(error, str):
            message = error
        # Azure's own refusals arrive unwrapped, as a bare {"message": ...}.
        # Reading only the nested form is how this check silently stopped
        # firing for exactly the endpoints it exists to catch.
        if not message and body.get("message"):
            message = str(body["message"])
    message = (message or str(exc)).lower()
    return any(hint in message for hint in _UNSUPPORTED_HINTS)


def _flatten_tools(tools: List[dict]) -> List[dict]:
    """Chat Completions nests the function; Responses does not."""
    flat = []
    for tool in tools or []:
        fn = tool.get("function") if isinstance(tool, dict) else None
        if fn:
            flat.append({
                "type": "function",
                "name": fn.get("name"),
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
            })
        else:
            flat.append(tool)
    return flat


class Dialogue:
    """
    A transcript plus the ability to take one more step in it.

    The neutral transcript is a list of Chat Completions style messages,
    because that is what both assistants already speak. Responses form is
    derived on demand.
    """

    def __init__(
        self,
        client: Any,
        model: str,
        tools: List[dict],
        max_tokens: int,
        temperature: float = 0.1,
        cache_key: str = "",
    ) -> None:
        self.client = client
        self.model = model
        self.tools = tools or []
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.messages: List[Dict[str, Any]] = []
        self._cache_key = cache_key or model
        # Responses is stateless for us: we resend the items each turn, so the
        # model's own reasoning items have to be kept alongside our messages.
        self._response_items: List[Dict[str, Any]] = []

    # --- building the transcript --------------------------------------

    def add(self, role: str, content: str) -> None:
        self.messages.append({"role": role, "content": content})

    def add_tool_result(self, call: ToolCall, payload: str) -> None:
        self.messages.append({
            "role": "tool",
            "tool_call_id": call.id,
            "content": payload,
        })
        self._response_items.append({
            "type": "function_call_output",
            "call_id": call.id,
            "output": payload,
        })

    # --- rendering ----------------------------------------------------

    def _as_input(self) -> List[Dict[str, Any]]:
        """The transcript as Responses input items."""
        items: List[Dict[str, Any]] = []
        for message in self.messages:
            role = message.get("role")
            if role == "tool":
                continue  # carried as function_call_output instead
            if role == "assistant" and message.get("tool_calls"):
                continue  # carried as the model's own returned items
            content = message.get("content")
            if not content:
                continue
            # Responses has no system role in the input list; the instruction
            # still belongs at the top, so it is sent as a developer turn.
            items.append({
                "role": "developer" if role == "system" else role,
                "content": str(content),
            })
        items.extend(self._response_items)
        return items

    # --- taking a step ------------------------------------------------

    async def step(self) -> Turn:
        protocol = _PROTOCOL.get(self._cache_key)

        if protocol == RESPONSES:
            return await self._step_responses()

        try:
            turn = await self._step_chat()
        except Exception as exc:  # noqa: BLE001
            if protocol == CHAT or not _looks_unsupported(exc):
                raise
            log.info(
                "Endpoint rejected chat completions as unsupported; "
                "trying the Responses API for %s",
                self.model,
            )
            try:
                turn = await self._step_responses()
            except Exception:  # noqa: BLE001
                # The first failure is the one that describes their setup.
                raise exc from None
            _PROTOCOL[self._cache_key] = RESPONSES
            return turn

        _PROTOCOL.setdefault(self._cache_key, CHAT)
        return turn

    async def _step_chat(self) -> Turn:
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": self.messages,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }
        if self.tools:
            kwargs["tools"] = self.tools
            kwargs["tool_choice"] = "auto"

        response = await self.client.chat.completions.create(**kwargs)
        choice = response.choices[0].message

        calls = [
            ToolCall(id=c.id, name=c.function.name, arguments=c.function.arguments or "{}")
            for c in (choice.tool_calls or [])
        ]
        if calls:
            self.messages.append(choice.model_dump(exclude_none=True))
        return Turn(text=choice.content or "", tool_calls=calls)

    async def _step_responses(self) -> Turn:
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "input": self._as_input(),
            "max_output_tokens": self.max_tokens,
        }
        if self.tools:
            kwargs["tools"] = _flatten_tools(self.tools)
            kwargs["tool_choice"] = "auto"
        # Temperature is deliberately omitted: the reasoning models that
        # require this API reject it.

        response = await self.client.responses.create(**kwargs)

        calls: List[ToolCall] = []
        produced: List[Dict[str, Any]] = []
        for item in getattr(response, "output", None) or []:
            kind = getattr(item, "type", None)
            produced.append(_dump(item))
            if kind == "function_call":
                calls.append(
                    ToolCall(
                        id=getattr(item, "call_id", "") or getattr(item, "id", ""),
                        name=getattr(item, "name", "") or "",
                        arguments=getattr(item, "arguments", "") or "{}",
                    )
                )

        if calls:
            # Reasoning items must be echoed back or the model loses its place.
            self._response_items.extend(produced)

        return Turn(text=getattr(response, "output_text", "") or "", tool_calls=calls)


def _dump(item: Any) -> Dict[str, Any]:
    dump = getattr(item, "model_dump", None)
    if callable(dump):
        try:
            return dump(exclude_none=True)
        except Exception:  # noqa: BLE001
            pass
    return item if isinstance(item, dict) else {"type": str(getattr(item, "type", "unknown"))}


def parse_arguments(raw: str) -> Dict[str, Any]:
    """Tool arguments, or an empty call when the model produced nothing valid."""
    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}
