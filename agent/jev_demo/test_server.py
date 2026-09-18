import http.client
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from server import Handler, BUSY
from unittest.mock import patch

class ServerBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.server.api_key = 'test-only-never-send'
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        conn.request(method, path, body, headers or {})
        response = conn.getresponse(); status = response.status; result = json.loads(response.read()); conn.close()
        return status, result

    def test_health_discloses_readiness_but_not_credentials(self):
        status, result = self.request('GET', '/api/jev/health')
        self.assertEqual(status, 200); self.assertTrue(result['ready'])
        self.assertNotIn(self.server.api_key, json.dumps(result))

    def test_foreign_origin_cannot_start_inference(self):
        status, _ = self.request('POST', '/api/jev/run', '{}', {'Origin': 'https://untrusted.example', 'X-Jev-Demo': '1'})
        self.assertEqual(status, 403)

    def test_foreign_host_is_rejected_even_without_origin(self):
        status, _ = self.request('GET', '/api/jev/health', headers={'Host': 'untrusted.example'})
        self.assertEqual(status, 403)

    def test_simple_cross_origin_post_cannot_start_inference(self):
        status, _ = self.request('POST', '/api/jev/run', '{}')
        self.assertEqual(status, 403)

    def test_bad_input_is_rejected_before_inference(self):
        status, _ = self.request('POST', '/api/jev/run', '{"prompt": 42}', {'X-Jev-Demo': '1'})
        self.assertEqual(status, 400)

    def test_classification_rejects_foreign_origin(self):
        status, _ = self.request('POST', '/api/jev/classify', '{}', {'Origin':'https://untrusted.example', 'X-Jev-Demo':'1'})
        self.assertEqual(status, 403)

    def test_classification_rejects_unknown_or_malformed_tasks(self):
        for task in ('unknown', [], None):
            status, _ = self.request('POST', '/api/jev/classify', json.dumps({'task':task, 'inputs':{}}), {'X-Jev-Demo':'1'})
            self.assertEqual(status, 400)

    def test_classification_returns_busy_before_api_call(self):
        BUSY.acquire()
        try:
            status, _ = self.request('POST', '/api/jev/classify', json.dumps({'task':'sentiment','inputs':{'text':'Great app.','target':'app'}}), {'X-Jev-Demo':'1'})
            self.assertEqual(status, 429)
        finally: BUSY.release()

    def test_api_failure_does_not_expose_exception_details(self):
        with patch('server.classify', side_effect=RuntimeError('sensitive-upstream-detail')):
            status, body = self.request('POST', '/api/jev/classify', json.dumps({'task':'sentiment','inputs':{'text':'Great app.','target':'app'}}), {'X-Jev-Demo':'1'})
        self.assertEqual(status, 502)
        self.assertNotIn('sensitive-upstream-detail', json.dumps(body))

if __name__ == '__main__': unittest.main()
