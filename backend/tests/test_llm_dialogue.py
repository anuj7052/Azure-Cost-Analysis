"""
Speaking to a deployment that refuses Chat Completions.

Azure's ``-pro`` reasoning deployments advertise ``chat_completion: false`` and
answer any Chat Completions call with "The requested operation is unsupported".
They are reachable only over the Responses API. These tests fix the behaviour
that discovery depends on -- when we fall back, when we must not, and that the
customer's own transcript survives the switch.
"""

import json

import pytest

from services import llm_dialogue
from services.llm_dialogue import CHAT, RESPONSES, Dialogue, ToolCall

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_subscriptions",
            "description": "List Azure subscriptions",
            "parameters": {"type": "object", "properties": {}},
        },
    }
]


@pytest.fixture(autouse=True)
def forget_protocols():
    llm_dialogue._PROTOCOL.clear()
    yield
    llm_dialogue._PROTOCOL.clear()


# --- fakes ------------------------------------------------------------


class Unsupported(Exception):
    status_code = 400
    body = {"error": {"message": "The requested operation is unsupported."}}


class NoSuchDeployment(Exception):
    status_code = 404
    body = {"error": {"message": "The API deployment for this resource does not exist."}}


class Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)

    def model_dump(self, **_):
        return {k: v for k, v in self.__dict__.items() if v is not None}


class FakeChat:
    def __init__(self, error=None, calls=None, content="chat answer"):
        self.error, self.calls, self.content = error, calls or [], content
        self.seen = []

    async def create(self, **kw):
        self.seen.append(kw)
        if self.error:
            raise self.error
        tool_calls = [
            Obj(id=c.id, function=Obj(name=c.name, arguments=c.arguments)) for c in self.calls
        ] or None
        message = Obj(content=self.content, tool_calls=tool_calls)
        return Obj(choices=[Obj(message=message)])


class FakeResponses:
    def __init__(self, calls=None, text="responses answer", error=None):
        self.calls, self.text, self.error = calls or [], text, error
        self.seen = []

    async def create(self, **kw):
        self.seen.append(kw)
        if self.error:
            raise self.error
        output = [Obj(type="reasoning", id="rs_1", summary=[])]
        for c in self.calls:
            output.append(
                Obj(type="function_call", call_id=c.id, name=c.name, arguments=c.arguments)
            )
        return Obj(output=output, output_text=self.text)


class FakeClient:
    def __init__(self, chat, responses):
        self.chat = Obj(completions=chat)
        self.responses = responses


def dialogue(chat, responses, key="ep|m"):
    client = FakeClient(chat, responses)
    talk = Dialogue(client, "gpt-5.4-pro", TOOLS, max_tokens=100, cache_key=key)
    talk.add("system", "be helpful")
    talk.add("user", "what have I got?")
    return talk, client


# --- falling back -----------------------------------------------------


async def test_a_deployment_that_refuses_chat_is_answered_over_responses():
    chat, responses = FakeChat(error=Unsupported()), FakeResponses()
    talk, _ = dialogue(chat, responses)
    turn = await talk.step()
    assert turn.text == "responses answer"
    assert len(responses.seen) == 1


async def test_the_protocol_is_remembered_so_the_wasted_call_happens_once():
    chat, responses = FakeChat(error=Unsupported()), FakeResponses()
    talk, _ = dialogue(chat, responses)
    await talk.step()
    await talk.step()
    # One failed chat attempt in total, not one per turn.
    assert len(chat.seen) == 1
    assert llm_dialogue._PROTOCOL["ep|m"] == RESPONSES


async def test_an_endpoint_that_works_is_left_on_chat_completions():
    chat, responses = FakeChat(), FakeResponses()
    talk, _ = dialogue(chat, responses)
    turn = await talk.step()
    assert turn.text == "chat answer"
    assert responses.seen == []
    assert llm_dialogue._PROTOCOL["ep|m"] == CHAT


async def test_a_wrong_deployment_name_is_not_retried_into_a_second_confusion():
    # 404 means they typed the wrong name. Retrying on another API would
    # replace a clear message with a stranger one.
    chat, responses = FakeChat(error=NoSuchDeployment()), FakeResponses()
    talk, _ = dialogue(chat, responses)
    with pytest.raises(NoSuchDeployment):
        await talk.step()
    assert responses.seen == []


async def test_when_both_apis_fail_the_first_error_is_the_one_reported():
    # The chat error describes what they configured; the fallback error is an
    # artefact of our own retry and would only mislead.
    chat = FakeChat(error=Unsupported())
    responses = FakeResponses(error=RuntimeError("responses also broke"))
    talk, _ = dialogue(chat, responses)
    with pytest.raises(Unsupported):
        await talk.step()


async def test_an_unrelated_failure_is_never_retried():
    boom = RuntimeError("network died")
    chat, responses = FakeChat(error=boom), FakeResponses()
    talk, _ = dialogue(chat, responses)
    with pytest.raises(RuntimeError):
        await talk.step()
    assert responses.seen == []


# --- the transcript survives the switch -------------------------------


async def test_the_system_prompt_is_carried_across_as_a_developer_turn():
    chat, responses = FakeChat(error=Unsupported()), FakeResponses()
    talk, _ = dialogue(chat, responses)
    await talk.step()
    roles = [i.get("role") for i in responses.seen[0]["input"]]
    assert roles == ["developer", "user"]


async def test_tools_are_flattened_for_the_responses_api():
    chat, responses = FakeChat(error=Unsupported()), FakeResponses()
    talk, _ = dialogue(chat, responses)
    await talk.step()
    tool = responses.seen[0]["tools"][0]
    assert tool["name"] == "list_subscriptions"
    assert "function" not in tool
    assert tool["parameters"]["type"] == "object"


async def test_temperature_is_not_sent_to_responses_models():
    # The reasoning models that require this API reject it outright.
    chat, responses = FakeChat(error=Unsupported()), FakeResponses()
    talk, _ = dialogue(chat, responses)
    await talk.step()
    assert "temperature" not in responses.seen[0]
    assert responses.seen[0]["max_output_tokens"] == 100


async def test_a_tool_result_is_returned_against_the_call_it_answers():
    call = ToolCall(id="call_1", name="list_subscriptions", arguments="{}")
    chat = FakeChat(error=Unsupported())
    responses = FakeResponses(calls=[call])
    talk, _ = dialogue(chat, responses)

    turn = await talk.step()
    assert [c.name for c in turn.tool_calls] == ["list_subscriptions"]

    talk.add_tool_result(turn.tool_calls[0], json.dumps({"count": 1}))
    await talk.step()

    items = responses.seen[1]["input"]
    outputs = [i for i in items if i.get("type") == "function_call_output"]
    assert outputs and outputs[0]["call_id"] == "call_1"
    assert json.loads(outputs[0]["output"]) == {"count": 1}


async def test_the_models_own_reasoning_is_echoed_back_so_it_keeps_its_place():
    call = ToolCall(id="call_1", name="list_subscriptions", arguments="{}")
    talk, _ = dialogue(FakeChat(error=Unsupported()), FakeResponses(calls=[call]))
    turn = await talk.step()
    talk.add_tool_result(turn.tool_calls[0], "{}")
    assert any(i.get("type") == "reasoning" for i in talk._response_items)


async def test_chat_tool_calls_are_reported_in_the_same_shape():
    # Callers must not be able to tell which protocol answered them.
    call = ToolCall(id="call_9", name="list_subscriptions", arguments='{"a":1}')
    talk, _ = dialogue(FakeChat(calls=[call]), FakeResponses())
    turn = await talk.step()
    assert turn.tool_calls[0].id == "call_9"
    assert turn.tool_calls[0].name == "list_subscriptions"


# --- reading what the model asked for ---------------------------------


def test_arguments_that_are_not_valid_json_become_an_empty_call():
    assert llm_dialogue.parse_arguments("not json") == {}
    assert llm_dialogue.parse_arguments("") == {}
    assert llm_dialogue.parse_arguments("[1,2]") == {}
    assert llm_dialogue.parse_arguments('{"months": 3}') == {"months": 3}


def test_only_a_genuine_unsupported_refusal_triggers_a_fallback():
    assert llm_dialogue._looks_unsupported(Unsupported()) is True
    assert llm_dialogue._looks_unsupported(NoSuchDeployment()) is False


def test_a_server_failure_is_never_read_as_an_unsupported_operation():
    class ServerError(Exception):
        status_code = 500
        body = {"error": {"message": "unsupported"}}

    assert llm_dialogue._looks_unsupported(ServerError()) is False
