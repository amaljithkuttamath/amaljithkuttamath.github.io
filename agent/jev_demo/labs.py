"""Named classification tasks shared with the browser; one bounded API call per run."""
import json
import math
import time
from pathlib import Path
import httpx

CATALOG = json.loads((Path(__file__).resolve().parents[2] / 'src/data/jev/labs.json').read_text())
TASKS = {task['id']: task for task in CATALOG}

def build_request(body):
    if not isinstance(body, dict) or not isinstance(body.get('task'), str) or body['task'] not in TASKS:
        raise ValueError('Choose a supported classification task.')
    task = TASKS[body['task']]
    inputs = body.get('inputs')
    if not isinstance(inputs, dict) or set(inputs) != {f['id'] for f in task['fields']}:
        raise ValueError('Provide exactly the fields required by this task.')
    state = {}
    for field in task['fields']:
        value = inputs[field['id']]
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= field['maxLength']:
            raise ValueError(f"{field['label']}: enter 1–{field['maxLength']} characters.")
        state[field['id']] = value.strip()
    return {'model': 'jev-latest', 'state': state, 'questions': task['questions']}

def finite(value): return type(value) in (int, float) and math.isfinite(value)

def validate_response(questions, raw):
    answers = raw.get('answers') if isinstance(raw, dict) else None
    if not isinstance(answers, dict): raise ValueError('TypeSafe returned no answer map.')
    for name, q in questions.items():
        a = answers.get(name)
        if not isinstance(a, dict) or a.get('type') != q['type']: raise ValueError('TypeSafe returned an incomplete typed answer.')
        if q['type'] == 'noul':
            if not finite(a.get('noul')) or not 0 <= a['noul'] <= 1: raise ValueError('Invalid yes probability.')
            continue
        keys = set(q['criteria']) if q['type'] == 'choice' else {str(i) for i in range(len(q['criteria']))}
        p = a.get('probabilities')
        if not isinstance(p, dict) or set(p) != keys: raise ValueError('Invalid answer distribution.')
        if any(not finite(v) or not 0 <= v <= 1 for v in p.values()) or abs(sum(p.values())-1) > .02: raise ValueError('Invalid answer probabilities.')
        if q['type'] == 'choice':
            if a.get('choice') not in keys or p[a['choice']] < max(p.values()) - 1e-6: raise ValueError('Invalid selected choice.')
        elif not finite(a.get('score')) or not 0 <= a['score'] <= len(keys)-1: raise ValueError('Invalid rubric score.')
    return raw

def classify(request, key):
    started = time.perf_counter()
    with httpx.Client(timeout=25) as client:
        response = client.post('https://api.typesafe.ai/v1/systemone', headers={'Authorization': 'Bearer ' + key}, json=request)
    if response.status_code != 200: raise RuntimeError(f'TypeSafe request failed (HTTP {response.status_code}).')
    raw = validate_response(request['questions'], response.json())
    return {'request': request, 'response': raw, 'latency_ms': round((time.perf_counter()-started)*1000, 2)}
