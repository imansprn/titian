"""Permission configuration, owner workflow and runtime migration; no live services."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/manager'))
import permissions
import manage
import runtime

class Policies(unittest.TestCase):
    def args(self, *values):
        parser = argparse.ArgumentParser()
        permissions.flags(parser)
        return parser.parse_args(values)

    def test_new_workspace_defaults_readonly(self):
        self.assertEqual(permissions.configure(self.args()), {'version': 2, 'preset': 'readonly', 'rules': {}})

    def test_task_template_uses_custom_rules_not_a_new_permission_level(self):
        result = permissions.configure(self.args('--template', 'developer'))
        self.assertEqual(result['preset'], 'custom')
        self.assertEqual(result['rules']['process.start'], 'ask')
        self.assertEqual(result['rules']['process.input'], 'ask')
        self.assertEqual(result['rules']['files.write'], 'allow')

    def test_custom_empty_is_deny_all_and_conflicts_fail(self):
        self.assertEqual(permissions.configure(self.args('--permissions', 'custom'))['rules'], {})
        with self.assertRaises(ValueError):
            permissions.configure(self.args('--permissions', 'custom', '--allow', 'process.start', '--deny', 'process.start'))
        with self.assertRaises(ValueError):
            permissions.configure(self.args('--permissions', 'editor', '--allow', 'process.start'))
        with self.assertRaises(ValueError):
            permissions.configure(self.args('--permissions', 'custom', '--allow', 'typo'))

    def test_invalid_saved_policy_is_not_silently_replaced(self):
        for invalid in [{}, {'version': True, 'preset': 'readonly', 'rules': {}}, {'version': 2, 'preset': {}, 'rules': {}}]:
            with self.assertRaises(ValueError): permissions.configure(self.args(), invalid)

    def test_custom_file_and_rule_overrides(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / 'policy.json'
            file.write_text(json.dumps({'version': 2, 'preset': 'custom', 'rules': {'files.read': 'allow'}}))
            result = permissions.configure(self.args('--policy-file', str(file), '--ask', 'process.start'))
            self.assertEqual(result['rules'], {'files.read': 'allow', 'process.start': 'ask'})

    def test_missing_runtime_does_not_claim_enforcement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, 'cannot enforce'): permissions.require_runtime(root)
            output = io.StringIO()
            with patch.object(permissions, 'owner_request', side_effect=OSError('not running')), contextlib.redirect_stdout(output):
                permissions.show(root, {'slug': 'demo', 'roots': ['/tmp'], 'permissions': permissions.configure(self.args())})
            result = json.loads(output.getvalue())
            self.assertEqual(result['activation'], 'unverified')
            self.assertIsNone(result['effective'])

    def test_configured_effective_mismatch_is_visible(self):
        project = {'slug': 'demo', 'roots': ['/tmp'], 'permissions': permissions.configure(self.args())}
        effective = {'policy': {'version': 2, 'preset': 'unrestricted', 'rules': {}}, 'roots': ['/tmp']}
        output = io.StringIO()
        with patch.object(permissions, 'owner_request', return_value=effective), contextlib.redirect_stdout(output):
            permissions.show(Path('/tmp'), project)
        self.assertEqual(json.loads(output.getvalue())['activation'], 'mismatch')

    def test_noninteractive_approval_is_rejected_before_contacting_owner_endpoint(self):
        args = argparse.Namespace(approval_action='approve', request_id='id')
        with patch('sys.stdin.isatty', return_value=False), patch.object(permissions, 'owner_request') as request:
            with self.assertRaisesRegex(ValueError, 'interactive local terminal'):
                permissions.approvals(Path('/tmp'), {'slug': 'demo'}, args)
            request.assert_not_called()

    def test_owner_confirmation_binds_to_the_displayed_request_hash(self):
        args = argparse.Namespace(approval_action='approve', request_id='id')
        preview = {'requestId': 'id', 'requestHash': 'server-generated-hash', 'status': 'pending'}
        with patch('sys.stdin.isatty', return_value=True), patch('sys.stdout.isatty', return_value=True), patch('builtins.input', return_value='approve id'), patch.object(permissions, 'owner_request', side_effect=[preview, {'status': 'approved'}]) as request, contextlib.redirect_stdout(io.StringIO()):
            # redirect_stdout replaces the stream, so check interactivity explicitly.
            with patch('sys.stdout.isatty', return_value=True):
                permissions.approvals(Path('/tmp'), {'slug': 'demo'}, args)
        self.assertEqual(request.call_args.args[-1], {'action': 'approve', 'requestId': 'id', 'requestHash': 'server-generated-hash'})

class Migration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['runtime', 'agents', 'launchagents', 'work']:
            (self.root / name).mkdir()
        (self.root / 'runtime/marker').write_text('old')
        self.project = {'slug': 'demo', 'name': 'Demo', 'roots': [str(self.root / 'work')], 'bridgePort': 8101, 'authPort': 8102, 'url': 'https://test.example/projects/demo/mcp'}
        self.patches = [patch.object(manage, 'ROOT', self.root), patch.object(runtime, 'ROOT', self.root), patch.object(manage, 'AGENTS', self.root / 'agents'), patch.object(manage, 'loaded', return_value=False), patch.object(manage, 'stop'), patch.object(manage, 'launch'), patch.object(manage, 'wait_health')]
        for p in self.patches: p.start(); self.addCleanup(p.stop)
        manage.save([self.project])

    def stage(self):
        stage = self.root / 'stage'; stage.mkdir(); (stage / 'marker').write_text('new'); return stage

    def test_legacy_activation_requires_explicit_choice_before_stopping_services(self):
        with self.assertRaisesRegex(ValueError, 'explicit permission choice'):
            runtime.activate(self.stage())
        manage.stop.assert_not_called()
        self.assertEqual((self.root / 'runtime/marker').read_text(), 'old')
        self.assertEqual(manage.load(), [self.project])

    def test_explicit_migration_regenerates_policy_environment(self):
        runtime.activate(self.stage(), 'readonly')
        result = manage.load()[0]
        self.assertEqual(result['permissions']['preset'], 'readonly')
        plist = plistlib.loads((self.root / 'agents/com.titian.demo.bridge.plist').read_bytes())
        self.assertEqual(json.loads(plist['EnvironmentVariables']['MCP_PERMISSION_POLICY']), result['permissions'])
        self.assertNotIn('MCP_ALLOWED_COMMANDS', plist['EnvironmentVariables'])
        self.assertEqual((self.root / 'runtime/marker').read_text(), 'new')

    def test_activation_failure_restores_runtime_registry_and_environment_files(self):
        for name in ['com.titian.demo.bridge.plist', 'com.titian.demo.auth.plist']:
            for directory in ['agents', 'launchagents']:
                (self.root / directory / name).write_bytes(b'original')
        with patch.object(manage, 'loaded', return_value=True), patch.object(manage, 'wait_health', side_effect=RuntimeError('startup failed')):
            with self.assertRaisesRegex(RuntimeError, 'startup failed'):
                runtime.activate(self.stage(), 'editor')
        self.assertEqual(manage.load(), [self.project])
        self.assertEqual((self.root / 'runtime/marker').read_text(), 'old')
        self.assertEqual((self.root / 'agents/com.titian.demo.bridge.plist').read_bytes(), b'original')

if __name__ == '__main__': unittest.main()
