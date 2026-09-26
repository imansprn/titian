"""First-install checks using temporary state; never starts production services."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import manage

class Bootstrap(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name, value in [('ROOT', self.root), ('AGENTS', self.root / 'agents')]:
            p = patch.object(manage, name, value); p.start(); self.addCleanup(p.stop)
        self.args = argparse.Namespace(origin='https://example.test', node=None, start_gateway=False)

    def test_init_is_idempotent_and_does_not_replace_credentials(self):
        manage.initialize(self.args)
        manage.save([{'slug':'demo','url':'https://example.test/projects/demo/mcp'}])
        key = self.root / 'instances/key'; key.write_text('test-secret')
        manage.initialize(self.args)
        self.assertEqual(key.read_text(), 'test-secret')
        self.assertEqual(manage.load()[0]['slug'], 'demo')
        self.assertTrue((self.root / 'launchagents/com.iman.project-mcp.gateway.plist').exists())
        self.assertEqual(manage.public_origin(), 'https://example.test')

    def test_invalid_origin_does_not_create_registry(self):
        for value in ['http://example.test', 'https://example.test/path', 'https://user:pass@example.test']:
            self.args.origin = value
            with self.assertRaises(ValueError): manage.initialize(self.args)
        self.assertFalse((self.root / 'projects.json').exists())

    def test_existing_issuer_cannot_be_replaced(self):
        manage.initialize(self.args)
        self.args.origin = 'https://different.test'
        with self.assertRaises(ValueError): manage.initialize(self.args)
        self.assertEqual(manage.public_origin(), 'https://example.test')

    def test_missing_registry_has_actionable_error(self):
        with self.assertRaisesRegex(ValueError, 'init --origin'): manage.load()

    def test_first_runtime_install_and_reinstall_protection(self):
        spec = importlib.util.spec_from_file_location('runtime_setup', Path(__file__).with_name('setup.py'))
        setup = importlib.util.module_from_spec(spec); spec.loader.exec_module(setup)
        def stage():
            p = self.root / 'stage'; p.mkdir(); (p / 'marker').write_text('built'); return p
        with patch.object(setup, 'ROOT', self.root), patch.object(setup, 'build', side_effect=stage), patch('sys.argv', ['setup.py', '--install']):
            setup.main()
            self.assertEqual((self.root / 'runtime/marker').read_text(), 'built')
            with self.assertRaisesRegex(RuntimeError, 'already exists'): setup.main()
            self.assertEqual((self.root / 'runtime/marker').read_text(), 'built')

if __name__ == '__main__': unittest.main()
