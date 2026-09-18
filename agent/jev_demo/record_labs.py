"""Capture actual Jev responses for every named example; never fabricate answers."""
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from labs import CATALOG, build_request, classify

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--credentials', type=Path)
    parser.add_argument('--out', type=Path, default=Path('src/data/jev/lab-recordings.json'))
    args = parser.parse_args()
    key = os.environ.get('TYPESAFE_API_KEY')
    if args.credentials:
        key = next((line.partition('=')[2].strip().strip('\"\'') for line in args.credentials.read_text().splitlines() if line.startswith('TYPESAFE_API_KEY=')), None)
    if not key: raise SystemExit('Missing TypeSafe key.')
    records = []
    for task in CATALOG:
        for example in task['examples']:
            request = build_request({'task': task['id'], 'inputs': example['inputs']})
            result = classify(request, key)
            records.append({'task': task['id'], 'example': example['id'], 'recorded_at': datetime.now(timezone.utc).isoformat(), **result})
            print(json.dumps({'task': task['id'], 'example': example['id'], 'latency_ms': result['latency_ms'], 'primary': result['response']['answers'][task['primary']]}), flush=True)
    # Replace only after all calls succeeded, so partial runs cannot overwrite a complete set.
    args.out.write_text(json.dumps(records, ensure_ascii=False, indent=2)+'\n')
    print(f'Saved {len(records)} real responses.')
