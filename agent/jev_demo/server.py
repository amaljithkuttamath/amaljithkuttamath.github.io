"""Loopback-only development server. The static GitHub Pages build has no server."""
import argparse
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from runtime import run_agent
from labs import build_request, classify

BUSY = threading.BoundedSemaphore(1)
ORIGINS = {'http://localhost:4321', 'http://127.0.0.1:4321'}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def allowed(self):
        host = urlparse('http://' + self.headers.get('Host', '')).hostname
        origin = self.headers.get('Origin')
        return host in ('localhost', '127.0.0.1') and (origin is None or origin in ORIGINS)

    def send_json(self, code, body):
        data = json.dumps(body).encode(); self.send_response(code)
        self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if not self.allowed(): return self.send_json(403, {'error': 'Origin not allowed.'})
        if self.path != '/api/jev/health': return self.send_json(404, {'error': 'Not found.'})
        self.send_json(200, {'ready': bool(self.server.api_key), 'engine': 'deepagents', 'mode': 'local_demo'})

    def do_POST(self):
        if not self.allowed() or self.headers.get('X-Jev-Demo') != '1': return self.send_json(403, {'error': 'Origin not allowed.'})
        if self.path not in ('/api/jev/run', '/api/jev/classify'): return self.send_json(404, {'error': 'Not found.'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32768: return self.send_json(413, {'error': 'Request too large.'})
            body = json.loads(self.rfile.read(size))
            if self.path == '/api/jev/classify':
                request = build_request(body)
            else:
                prompt = body.get('prompt')
                if not isinstance(prompt, str) or not 5 <= len(prompt.strip()) <= 1500: return self.send_json(400, {'error': 'Write a request between 5 and 1,500 characters.'})
        except (ValueError, AttributeError): return self.send_json(400, {'error': 'Invalid request.'})
        if not self.server.api_key: return self.send_json(503, {'error': 'TypeSafe key is not configured on the local server.'})
        if not BUSY.acquire(blocking=False): return self.send_json(429, {'error': 'Another demo is running. Try again when it finishes.'})
        try:
            if self.path == '/api/jev/classify':
                try: return self.send_json(200, classify(request, self.server.api_key))
                except (BrokenPipeError, ConnectionResetError): return
                except Exception:
                    return self.send_json(502, {'error': 'Classification failed. Check the local runtime or try again.'})
            self.send_response(200); self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Cache-Control', 'no-store'); self.send_header('X-Accel-Buffering', 'no'); self.end_headers()
            def emit(event): self.wfile.write((json.dumps(event) + '\n').encode()); self.wfile.flush()
            try: run_agent(prompt.strip(), self.server.api_key, emit)
            except (BrokenPipeError, ConnectionResetError): pass
            except Exception as exc:
                message = str(exc) if isinstance(exc, (RuntimeError, ValueError)) else 'The agent run failed. Check the local runtime.'
                try: emit({'type': 'error', 'message': message})
                except (BrokenPipeError, ConnectionResetError): pass
        finally: BUSY.release()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--credentials', type=Path); parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args(); key = os.environ.get('TYPESAFE_API_KEY')
    if args.credentials:
        key = next((line.partition('=')[2].strip().strip('\"\'') for line in args.credentials.read_text().splitlines() if line.strip().startswith('TYPESAFE_API_KEY=')), None)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler); server.api_key = key
    print(f'Jev / Deep Agents development server on 127.0.0.1:{args.port}; key configured: {bool(key)}', flush=True)
    server.serve_forever()
