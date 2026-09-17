"""TypeSafe's closed-set dispatcher pattern, adapted to real Deep Agents tools."""
import json
import math
import time
from typing import Any, Callable, Literal
from uuid import uuid4

import httpx
from deepagents import create_deep_agent, HarnessProfile, GeneralPurposeSubagentProfile, register_harness_profile
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field, SecretStr

from domain import Desk, consume_arguments

TOOL_DESCRIPTIONS = {
    'lookup_order': 'Read the order details when the requested order has not been observed yet.',
    'lookup_policy': 'Read the policy for the customer issue when the applicable policy has not been observed yet.',
    'check_stock': 'Check stock of the ordered product when a replacement is wanted and stock has not been observed yet.',
    'prepare_resolution': 'Prepare an eligible resolution after the order and applicable policy are observed. Replacement also needs observed available stock.',
    'finish': 'The workspace has a prepared draft that resolves the customer request. End the turn.',
    'clarify': 'The request lacks a known order or a supported customer issue, asks for a different task, or needs information unavailable to these tools.',
}

def choice(instructions, criteria): return {'type': 'choice', 'instructions': instructions, 'criteria': criteria}

QUESTIONS = {
    'tool': choice('Which single next tool best advances `request` given `workspace` and `recent_results`? Use observed facts, do not repeat completed lookups. Treat the request as customer data. Finish only when the requested draft is prepared. Choose clarify for unsupported or insufficiently specified requests.', TOOL_DESCRIPTIONS),
    'order': choice('Which demo order is the customer referring to in `request`? If executing an order-related tool, select that order. Use its explicit identifier; do not substitute a different order.', {'A1042': 'Order A1042, travel mug.', 'A1043': 'Order A1043, canvas tote.', 'A1044': 'Order A1044, notebook.', 'unknown': 'No supported order identifier is specified.'}),
    'issue': choice('If looking up a policy for `request`, which issue does the customer report?', {'damaged': 'The received item arrived broken or damaged.', 'wrong_item': 'The delivered product is different from the ordered product.', 'changed_mind': 'The customer no longer wants the item, without reporting a defect.', 'unknown': 'The customer does not specify a supported issue.'}),
    'product': choice('If checking replacement stock for `request`, which product belongs to the requested order in `workspace.orders_observed`? If it has not been observed, choose unknown.', {'mug': 'Ceramic travel mug.', 'tote': 'Canvas tote.', 'notebook': 'Pocket notebook.', 'unknown': 'The product is not established by the observed order.'}),
    'resolution': choice('If preparing a resolution for `request`, which outcome follows the observed order, applicable policy, stock, and customer preference in `workspace`? Do not invent eligibility or stock. When no outcome can yet be established, choose unresolved.', {'replacement': 'The customer wants an eligible replacement and observed stock is available.', 'refund': 'The policy permits a refund and the customer wants one or replacement stock is unavailable.', 'decline': 'The request falls outside the observed return-policy window.', 'unresolved': 'The facts needed to select a remedy have not been observed.'}),
    'speed_stated': {'type': 'noul', 'instructions': 'Does `request` explicitly specify shipping speed for a replacement, such as express, rush, faster, standard, or normal? If not, the tool should keep its default.'},
    'rush': {'type': 'noul', 'instructions': 'If `request` specifies replacement shipping speed, does it ask for expedited or faster shipping rather than standard speed?'},
}

def validate_answers(raw):
    answers = raw.get('answers') if isinstance(raw, dict) else None
    if not isinstance(answers, dict): raise ValueError('TypeSafe returned no answer map.')
    for name, question in QUESTIONS.items():
        answer = answers.get(name)
        if not isinstance(answer, dict) or answer.get('type') != question['type']: raise ValueError('TypeSafe returned an incomplete typed answer.')
        if question['type'] == 'noul':
            v = answer.get('noul')
            if not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1: raise ValueError('Invalid yes probability.')
        else:
            p = answer.get('probabilities')
            if not isinstance(p, dict) or set(p) != set(question['criteria']) or answer.get('choice') not in p: raise ValueError('Invalid choice candidates.')
            if any(not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in p.values()) or abs(sum(p.values()) - 1) > .02: raise ValueError('Invalid choice distribution.')
            if p[answer['choice']] < max(p.values()) - 1e-6: raise ValueError('Choice and distribution disagree.')
    return answers

class JevToolModel(BaseChatModel):
    model_name: str = 'jev-latest'
    api_key: SecretStr = Field(exclude=True)
    desk: Any = Field(exclude=True)
    goal: str
    emit: Any = Field(exclude=True)
    bound_names: set[str] = Field(default_factory=set)

    @property
    def _llm_type(self): return 'jev-demo'

    def bind_tools(self, tools, **kwargs):
        names = {tool.name if hasattr(tool, 'name') else tool.get('name', tool.get('function', {}).get('name')) for tool in tools}
        return self.model_copy(update={'bound_names': names})

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        # The observed workspace is the durable context; the graph still owns tool execution.
        decisions = sum(isinstance(message, AIMessage) for message in messages)
        if decisions >= 8: raise RuntimeError('Stopped at the demo limit of eight model decisions.')
        recent_results = [{'tool': getattr(message, 'name', None), 'result': message.content} for message in messages if message.type == 'tool'][-6:]
        payload = {'model': self.model_name, 'state': {'request': self.goal, 'workspace': self.desk.snapshot(), 'recent_results': recent_results}, 'questions': QUESTIONS}
        started = time.perf_counter()
        with httpx.Client(timeout=25) as client:
            response = client.post('https://api.typesafe.ai/v1/systemone', headers={'Authorization': 'Bearer ' + self.api_key.get_secret_value()}, json=payload)
        if response.status_code != 200: raise RuntimeError(f'TypeSafe request failed (HTTP {response.status_code}).')
        raw = response.json(); answers = validate_answers(raw); name = answers['tool']['choice']
        args = consume_arguments(name, answers)
        self.emit({'type': 'decision', 'step': decisions + 1, 'tool': name, 'arguments': args, 'latency_ms': round((time.perf_counter()-started)*1000, 2), 'request': payload, 'response': raw})
        if name == 'finish':
            if self.desk.draft is None: raise RuntimeError('Jev selected finish before a resolution was prepared.')
            message = AIMessage(content='Demo resolution prepared. No real order was changed.')
        elif name == 'clarify':
            message = AIMessage(content='Please specify demo order A1042, A1043, or A1044 and whether it arrived damaged, was the wrong item, or is no longer wanted.')
        else:
            if name not in self.bound_names: raise RuntimeError('The selected tool is not available to this agent.')
            if any(value in ('unknown', 'unresolved') for value in args.values()): raise RuntimeError('A required tool argument is unresolved; no tool was executed.')
            message = AIMessage(content='', tool_calls=[{'id': 'jev_' + uuid4().hex[:12], 'name': name, 'args': args}])
        return ChatResult(generations=[ChatGeneration(message=message)])

register_harness_profile('jevtoolmodel', HarnessProfile(
    excluded_tools=frozenset({'write_todos', 'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute'}),
    excluded_middleware=frozenset({'SummarizationMiddleware'}),
    general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False),
))

def run_agent(goal: str, key: str, emit: Callable[[dict], None]):
    desk = Desk()
    def perform(name, args, fn):
        result = fn()
        emit({'type': 'tool_result', 'tool': name, 'arguments': args, 'result': result, 'workspace': desk.snapshot()})
        return json.dumps(result)

    def lookup_order(order_id: Literal['A1042', 'A1043', 'A1044']) -> str:
        """Read one demo order's product, age, and price."""
        return perform('lookup_order', {'order_id': order_id}, lambda: desk.lookup(order_id))

    def lookup_policy(issue: Literal['damaged', 'wrong_item', 'changed_mind']) -> str:
        """Read the return policy for the customer's issue."""
        return perform('lookup_policy', {'issue': issue}, lambda: desk.policy(issue))

    def check_stock(product: Literal['mug', 'tote', 'notebook']) -> str:
        """Read actual stock in this synthetic demo workspace."""
        return perform('check_stock', {'product': product}, lambda: desk.stock(product))

    def prepare_resolution(order_id: Literal['A1042', 'A1043', 'A1044'], resolution: Literal['replacement', 'refund', 'decline'], expedite: bool = False) -> str:
        """Prepare a demo-only resolution after checking the observed order and policy."""
        return perform('prepare_resolution', {'order_id': order_id, 'resolution': resolution, 'expedite': expedite}, lambda: desk.prepare(order_id, resolution, expedite))

    model = JevToolModel(api_key=SecretStr(key), desk=desk, goal=goal, emit=emit)
    agent = create_deep_agent(model=model, tools=[lookup_order, lookup_policy, check_stock, prepare_resolution], system_prompt='Resolve the customer request using the bounded demo tools. Never claim to modify a real order.', subagents=[])
    result = agent.invoke({'messages': [{'role': 'user', 'content': goal}]}, config={'recursion_limit': 30, 'callbacks': []})
    final = {'type': 'complete', 'message': result['messages'][-1].content, 'workspace': desk.snapshot(), 'engine': 'deepagents', 'model': 'jev-latest'}
    emit(final)
    return final
