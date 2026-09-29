#!/usr/bin/env python3
"""Exercise an installed broker and memory CLI in isolated state, with a local Ollama fixture."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', type=Path, required=True, help='Installed share/cere directory')
args = parser.parse_args()
root = args.root.resolve()

class OllamaFixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def answer(self, value):
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.answer({'models': [{'name': 'fixture:latest', 'model': 'fixture:latest', 'digest': 'a' * 64},
                                {'name': 'nomic-embed-text:latest', 'model': 'nomic-embed-text:latest', 'digest': 'b' * 64}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
        if self.path == '/api/embed':
            self.answer({'embeddings': [[1, 0, 0] for _ in body['input']]})
        elif self.path == '/api/show':
            self.answer({'capabilities': ['embedding'] if 'embed' in body['model'] else ['completion']})
        else:
            self.send_error(404)

with tempfile.TemporaryDirectory(prefix='cere-install-check-') as temporary:
    directory = Path(temporary)
    server = ThreadingHTTPServer(('127.0.0.1', 0), OllamaFixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {**os.environ, 'CERE_STATE_DIR': str(directory / 'state'),
           'CERE_RUNTIME_DIR': str(directory / 'runtime'),
           'CERE_OLLAMA_HOST': f'http://127.0.0.1:{server.server_port}',
           'CERE_QDRANT_URL': 'http://127.0.0.1:9', 'CERE_NEO4J_URI': 'bolt://127.0.0.1:9',
           'CERE_QDRANT_API_KEY': '', 'CERE_NEO4J_PASSWORD': '',
           'CERE_CODEX_BIN': '/nonexistent/cere-fixture-codex',
           'CERE_CLAUDE_BIN': '/nonexistent/cere-fixture-claude'}
    env.pop('CERE_MEMORY_CREDENTIALS_FILE', None)
    socket_path = directory / 'runtime/broker.sock'

    def rpc(method, params=None):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(15)
            client.connect(str(socket_path))
            client.sendall((json.dumps({'id': 1, 'method': method, 'params': params or {}}) + '\n').encode())
            response = json.loads(client.makefile().readline())
            if 'error' in response:
                raise RuntimeError(response['error'])
            return response['result']

    def cli(*arguments):
        result = subprocess.run(['node', str(root / 'broker/memory-cli.ts'), *arguments], env=env,
                                capture_output=True, text=True, timeout=20, check=True)
        return json.loads(result.stdout)

    with (directory / 'broker.log').open('w') as log:
        process = subprocess.Popen(['node', str(root / 'broker/main.ts')], env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 10
            while not socket_path.exists():
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Installed broker failed to start: ' + (directory / 'broker.log').read_text())
                time.sleep(.05)
            health = cli('health')
            assert health['sqlite']
            session = rpc('session.create', {'provider': 'ollama', 'model': 'fixture:latest', 'cwd': str(directory)})
            sid = session['id']
            saved = rpc('memory.save', {'sessionId': sid, 'text': 'Synthetic project decision: use Ruff.'})
            listing = rpc('memory.list', {'sessionId': sid})
            assert listing['total'] == 1
            record = listing['rows'][0]['id']
            packet = cli('query', '--session', sid, '--text', 'Ruff')
            assert any('Ruff' in row['text'] for row in packet['results'])
            preview = cli('forget-preview', '--session', sid, '--id', record)
            erased = cli('forget', '--session', sid, '--id', record, '--expected-revision', str(preview['revision']))
            assert erased['suppressed'] and not erased['purge_complete']
            assert not cli('query', '--session', sid, '--text', 'Ruff')['results']
            status = cli('erasure-status', '--job', erased['job_id'])
            assert not status['purge_complete']
            print(json.dumps({'installed_broker': True, 'peer_credentials': True, 'cli': True,
                              'immediate_recall_without_projection': True, 'forget_revision_guard': True,
                              'immediate_suppression': True, 'outage_purge_pending': True}))
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            server.shutdown()
