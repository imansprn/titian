"""Fault injection against temporary manager state; no production services changed."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import manage


class Transactions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.patches = [patch.object(manage, 'ROOT', root), patch.object(manage, 'AGENTS', root / 'agents'),
                        patch.object(manage, 'loaded', return_value=False), patch.object(manage, 'launch'),
                        patch.object(manage, 'stop'), patch.object(manage, 'wait_health')]
        for p in self.patches: p.start(); self.addCleanup(p.stop)
        for name in ['agents','launchagents','instances/demo','logs','code','runtime/bridge','runtime/dc/dist']:
            (root / name).mkdir(parents=True, exist_ok=True)
        for name in ['runtime/auth-proxy.cjs','runtime/bridge/bridge.js','runtime/dc/dist/index.js']:
            (root / name).write_text('// fixture')
        self.root = root
        self.project = {'slug':'demo','name':'Demo','roots':[str(root / 'code')],'bridgePort':8107,'authPort':8108,'url':'https://example.test/projects/demo/mcp'}
        manage.save([self.project])
        (root / 'instances/demo/config.json').write_text(json.dumps({'allowedDirectories':self.project['roots']}))
        (root / 'instances/demo/.oauth-signing-key').write_text('test-key')
        for part in ['auth','bridge']:
            for folder in [root / 'agents',root / 'launchagents']:
                (folder / (manage.label('demo',part)+'.plist')).write_text('original-plist')

    def assert_original(self):
        self.assertEqual(manage.load(), [self.project])
        self.assertEqual((self.root / 'instances/demo/.oauth-signing-key').read_text(), 'test-key')
        for part in ['auth','bridge']:
            self.assertEqual((manage.AGENTS / (manage.label('demo',part)+'.plist')).read_text(),'original-plist')
        self.assertFalse((self.root / 'transaction').exists())

    def test_remove_archive_failure_restores_registry_and_autostart(self):
        real_replace = manage.os.replace
        def fail_state(source, dest):
            if Path(dest) == self.root / 'transaction/state': raise OSError('archive unavailable')
            return real_replace(source,dest)
        with patch.object(manage.os,'replace',side_effect=fail_state):
            with self.assertRaises(OSError):
                manage.change(argparse.Namespace(action='remove',project='demo',dry_run=False),manage.load())
        self.assert_original()

    def test_update_startup_failure_restores_config(self):
        old = (self.root / 'instances/demo/config.json').read_text()
        with patch.object(manage,'wait_health',side_effect=RuntimeError('startup failed')):
            with self.assertRaises(RuntimeError):
                manage.change(argparse.Namespace(action='update',project='demo',dry_run=False,name='Changed',paths=[]),manage.load())
        self.assert_original()
        self.assertEqual((self.root / 'instances/demo/config.json').read_text(),old)

    def test_interrupted_remove_is_recoverable(self):
        tx=manage.snapshot(manage.load(), self.project)
        manage.save([])
        manage.os.replace(self.root / 'instances/demo',tx / 'state')
        (manage.AGENTS / (manage.label('demo','auth')+'.plist')).unlink()
        manage.recover()
        self.assert_original()

    def test_committed_remove_finishes_without_resurrecting_project(self):
        real_finish = manage.finish_transaction
        with patch.object(manage,'finish_transaction',side_effect=OSError('interrupted finalization')):
            with self.assertRaises(OSError): manage.change(argparse.Namespace(action='remove',project='demo',dry_run=False),manage.load())
        self.assertEqual(manage.load(), [])
        manage.recover()
        self.assertEqual(manage.load(), [])
        self.assertFalse((self.root / 'instances/demo').exists())
        self.assertFalse((self.root / 'transaction').exists())

    def test_add_failure_rolls_back_new_files(self):
        with patch.object(manage,'make_project',return_value=dict(self.project,slug='new',url='https://example.test/projects/new/mcp')):
            with patch.object(manage,'wait_health',side_effect=RuntimeError('startup failed')):
                with self.assertRaises(RuntimeError):
                    manage.add(argparse.Namespace(name='New',paths=self.project['roots'],slug='new',dry_run=False),manage.load())
        self.assertEqual(manage.load(),[self.project])
        self.assertFalse((self.root / 'instances/new').exists())
        self.assertFalse((manage.AGENTS / (manage.label('new','auth')+'.plist')).exists())

    def test_add_without_existing_desktop_commander_config(self):
        project = dict(self.project, slug='fresh', url='https://example.test/projects/fresh/mcp')
        with patch.object(manage, 'make_project', return_value=project), patch.object(Path, 'home', return_value=self.root / 'new-user'):
            manage.add(argparse.Namespace(name='Fresh', paths=project['roots'], slug='fresh', dry_run=False), manage.load())
        config = json.loads((self.root / 'instances/fresh/config.json').read_text())
        self.assertEqual(config['allowedDirectories'], project['roots'])
        self.assertFalse(config['telemetryEnabled'])
        self.assertEqual(manage.load()[-1]['slug'], 'fresh')

    def test_rotation_preserves_open_inode_and_retention(self):
        import gzip
        log=self.root/'logs/service.log';log.write_text('a'*2048)
        inode=log.stat().st_ino
        manage.rotate_logs(argparse.Namespace(max_mb=.001,keep=2))
        self.assertEqual(log.stat().st_ino,inode)
        self.assertEqual(log.stat().st_size,0)
        with gzip.open(str(log)+'.1.gz','rt') as f:self.assertEqual(f.read(),'a'*2048)


class Build(unittest.TestCase):
    def test_patch_fails_closed_on_source_drift(self):
        spec=importlib.util.spec_from_file_location('runtime_setup',Path(__file__).with_name('setup.py'))
        setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)
        with self.assertRaises(RuntimeError): setup.replace_once('different source','expected','replacement')
        with self.assertRaises(RuntimeError): setup.replace_once('expected expected','expected','replacement')


if __name__ == '__main__':unittest.main()
