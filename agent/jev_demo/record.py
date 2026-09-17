"""Run and retain actual Deep Agents traces; credentials are never serialized."""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from runtime import run_agent

parser = argparse.ArgumentParser()
parser.add_argument('--credentials', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
key = next((line.partition('=')[2].strip().strip('\"\'') for line in args.credentials.read_text().splitlines() if line.strip().startswith('TYPESAFE_API_KEY=')), None)
if not key: raise SystemExit('Missing TypeSafe key.')
scenarios = [
    ('replacement', 'My mug in order A1042 arrived broken. Can you arrange a replacement with express shipping?'),
    ('out-of-stock', 'Order A1043 arrived damaged. Replace it if you have stock; otherwise prepare a refund.'),
    ('expired', 'I changed my mind about the notebook in order A1044. Please prepare a refund.'),
]
args.out.mkdir(parents=True, exist_ok=True)
for identifier, prompt in scenarios:
    events = []
    def emit(event):
        events.append(event)
        print(json.dumps({'scenario': identifier, 'type': event['type'], 'tool': event.get('tool'), 'arguments': event.get('arguments'), 'result': event.get('result')}), flush=True)
    try:
        run_agent(prompt, key, emit)
    except Exception as exc:
        events.append({'type': 'error', 'message': str(exc)})
        print(type(exc).__name__, str(exc), flush=True)
    (args.out / (identifier + '.json')).write_text(json.dumps({'id': identifier, 'prompt': prompt, 'recorded_at': datetime.now(timezone.utc).isoformat(), 'events': events}, indent=2) + '\n')
