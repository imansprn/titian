"""Live lifecycle check using temporary project folders; leaves existing projects intact."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
SLUG = 'manager-lifecycle-check'

def run(*args, ok=True, env=None):
    result = subprocess.run([sys.executable, str(ROOT / 'manage.py'), *args], text=True, capture_output=True, env=env)
    assert (result.returncode == 0) == ok, result.stdout + result.stderr
    return result

def status(path):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8300' + path, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code

before = json.loads((ROOT / 'projects.json').read_text())
assert not any(p['slug'] == SLUG for p in before)
with tempfile.TemporaryDirectory(prefix='mcp-manager-test-') as tmp:
    first, second = Path(tmp) / 'web', Path(tmp) / 'mobile'
    first.mkdir(); second.mkdir()
    marker = first / 'keep.txt'; marker.write_text('project files survive MCP removal')
    try:
        run('add', 'Manager lifecycle check', str(first), str(second), '--slug', SLUG, '--dry-run')
        assert json.loads((ROOT / 'projects.json').read_text()) == before
        run('add', 'Invalid', str(first / 'missing'), ok=False)
        run('add', 'Manager lifecycle check', str(first), str(second), '--slug', SLUG)
        after = json.loads((ROOT / 'projects.json').read_text())
        assert after[:-1] == before and after[-1]['roots'] == [str(first.resolve()), str(second.resolve())]
        run('add', 'Duplicate', str(first), '--slug', SLUG, ok=False)
        assert status('/projects/' + SLUG + '/mcp') == 401
        assert status('/.well-known/oauth-protected-resource/projects/' + SLUG + '/mcp') == 200
        result = subprocess.run([sys.executable, str(ROOT / 'verify.py')], env={**os.environ, 'MCP_TEST_PROJECT': SLUG}, text=True, capture_output=True)
        assert result.returncode == 0, result.stdout + result.stderr
        print(result.stdout.strip())
        run('remove', SLUG, '--dry-run')
        assert status('/projects/' + SLUG + '/mcp') == 401
        result = run('remove', SLUG)
        assert status('/projects/' + SLUG + '/mcp') == 404
        assert status('/.well-known/oauth-protected-resource/projects/' + SLUG + '/mcp') == 404
        assert marker.read_text() == 'project files survive MCP removal'
        assert json.loads((ROOT / 'projects.json').read_text()) == before
        assert not (ROOT / 'instances' / SLUG).exists()
        archives = list((ROOT / 'archives').glob(SLUG + '-*'))
        assert any((p / 'state/.oauth-signing-key').exists() for p in archives)
        for part in ['auth', 'bridge']:
            label = f'com.iman.project-mcp.{SLUG}.{part}'
            assert not (Path.home() / 'Library/LaunchAgents' / (label + '.plist')).exists()
            assert subprocess.run(['launchctl', 'print', f'gui/{os.getuid()}/{label}'], capture_output=True).returncode != 0
        run('remove', SLUG, ok=False)
        print('PASS add/remove lifecycle, dry runs, duplicate/missing-path rejection, multi-root config, live routing, service cleanup, archived secrets, project files preserved')
    finally:
        if any(p['slug'] == SLUG for p in json.loads((ROOT / 'projects.json').read_text())):
            run('remove', SLUG)
