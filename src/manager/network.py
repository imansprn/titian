"""External endpoint provider configuration and Cloudflare Tunnel lifecycle."""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


CLOUDFLARED_LABEL = 'com.titian.cloudflared'
TOKEN_RELATIVE_PATH = Path('secrets/cloudflare-tunnel-token')
MIN_TOKEN_FILE_VERSION = (2025, 4, 0)


def hostname(value):
    if not value or '://' in value or '/' in value or ':' in value or '@' in value:
        raise ValueError('Hostname must contain only a DNS name, for example mcp.example.com.')
    try:
        result = value.rstrip('.').encode('idna').decode('ascii').lower()
    except UnicodeError as error:
        raise ValueError('Hostname is not a valid DNS name.') from error
    labels = result.split('.')
    if (len(result) > 253 or len(labels) < 2 or
            any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels)):
        raise ValueError('Hostname must be a fully qualified DNS name.')
    return result


def cloudflared_binary(value=None, configured=None):
    candidate = value or configured or shutil.which('cloudflared')
    if not candidate:
        raise ValueError('cloudflared is not installed or not on PATH. Install it explicitly, then retry.')
    path = Path(candidate).expanduser().resolve()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f'cloudflared is not an executable file: {path}')
    return str(path)


def cloudflared_version(binary):
    try:
        result = subprocess.run([binary, 'version'], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f'Could not run cloudflared version: {error}') from error
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'cloudflared version failed.')
    match = re.search(r'\bversion\s+(\d+)\.(\d+)\.(\d+)', result.stdout + result.stderr, re.I)
    if not match:
        raise ValueError('Could not read the cloudflared version.')
    version = tuple(map(int, match.groups()))
    if version < MIN_TOKEN_FILE_VERSION:
        raise ValueError('Cloudflare token files require cloudflared 2025.4.0 or later; update cloudflared explicitly.')
    return version


def validate_tunnel_id(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError('Tunnel ID must be a UUID.') from error


def metrics_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def _plist_bytes(value):
    import plistlib
    return plistlib.dumps(value)


def tunnel_plist(manage, config):
    binary = config['cloudflaredBinary']
    token = str(manage.ROOT / TOKEN_RELATIVE_PATH)
    port = int(config['metricsPort'])
    logs = manage.ROOT / 'logs'
    return _plist_bytes({
        'Label': CLOUDFLARED_LABEL,
        'ProgramArguments': [binary, 'tunnel', '--no-autoupdate', '--metrics', f'127.0.0.1:{port}', 'run', '--token-file', token],
        'WorkingDirectory': str(manage.ROOT),
        'EnvironmentVariables': {},
        'RunAtLoad': True,
        'KeepAlive': True,
        'ThrottleInterval': 10,
        'StandardOutPath': str(logs / 'cloudflared.log'),
        'StandardErrorPath': str(logs / 'cloudflared.err.log'),
    })


def ready(config, timeout=2):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{config['metricsPort']}/ready", timeout=timeout) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def wait_ready(config, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if ready(config):
            return
        time.sleep(0.25)
    raise RuntimeError('cloudflared did not become ready. Check the cloudflared error log, Tunnel token, and outbound network access.')


def _replace_origin(project, origin):
    parsed = urllib.parse.urlsplit(project['url'])
    return urllib.parse.urlunsplit(('https', urllib.parse.urlsplit(origin).netloc, parsed.path, '', ''))


def _begin_transaction(manage, paths, running, cloudflared_running, projects, old_network):
    root = manage.ROOT / 'network-transaction'
    stage = manage.ROOT / 'network-transaction.tmp'
    if root.exists():
        raise RuntimeError('Network transaction is pending. Run titian recover first.')
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(mode=0o700)
    files = []
    for index, path in enumerate(dict.fromkeys(paths)):
        entry = {'path': str(path), 'backup': None, 'mode': None}
        if path.is_file():
            backup = stage / f'file-{index}'
            shutil.copyfile(path, backup)
            backup.chmod(0o600)
            entry.update(backup=backup.name, mode=stat.S_IMODE(path.stat().st_mode))
        files.append(entry)
    record = {
        'files': files,
        'running': running,
        'cloudflaredRunning': cloudflared_running,
        'ports': {manage.label(project['slug'], part): project[part + 'Port']
                  for project in projects for part in ['auth', 'bridge']},
        'network': old_network,
    }
    manage.atomic(stage / 'record.json', (json.dumps(record, indent=2) + '\n').encode(), 0o600)
    os.replace(stage, root)
    return root


def _finish_transaction(path):
    shutil.rmtree(path)


def recover(manage):
    """Roll back an interrupted provider change and restart previously loaded services."""
    root = manage.ROOT / 'network-transaction'
    if not root.exists():
        return
    if (root / 'committed').exists():
        _finish_transaction(root)
        print('Completed network transaction cleaned up.')
        return
    record = json.loads((root / 'record.json').read_text())
    to_stop = list(record.get('running', []))
    if manage.loaded(CLOUDFLARED_LABEL):
        to_stop.append(CLOUDFLARED_LABEL)
    for name in to_stop:
        manage.stop(name)
    for entry in record['files']:
        path = Path(entry['path'])
        backup = root / entry['backup'] if entry['backup'] else None
        if backup is None:
            path.unlink(missing_ok=True)
        else:
            manage.atomic(path, backup.read_bytes(), int(entry['mode']))
    for name in record.get('running', []):
        plist = manage.AGENTS / (name + '.plist')
        if plist.exists():
            manage.launch('bootstrap', manage.DOMAIN, str(plist))
            port = record.get('ports', {}).get(name)
            if port:
                manage.wait_health(port)
    old_network = record.get('network') or {}
    if record.get('cloudflaredRunning') and old_network.get('provider') == 'cloudflare':
        plist = manage.AGENTS / (CLOUDFLARED_LABEL + '.plist')
        if plist.exists():
            manage.launch('bootstrap', manage.DOMAIN, str(plist))
            wait_ready(old_network, timeout=15)
    _finish_transaction(root)
    print('Interrupted network change rolled back.')


def configure(manage, args, projects):
    if sys.platform != 'darwin':
        raise ValueError('Network provider activation requires macOS launchd.')
    old_settings = manage.settings()
    old_projects = projects
    new_settings = dict(old_settings)
    new_projects = [dict(project) for project in old_projects]

    if args.provider == 'cloudflare':
        host = hostname(args.hostname)
        tunnel_id = validate_tunnel_id(args.tunnel_id)
        binary = cloudflared_binary(args.cloudflared, (old_settings.get('network') or {}).get('cloudflaredBinary'))
        version = cloudflared_version(binary)
        source = Path(args.token_file).expanduser().resolve(strict=True)
        if not source.is_file():
            raise ValueError('Tunnel token file must be a regular file.')
        token = source.read_text().strip()
        if not token or any(char.isspace() for char in token):
            raise ValueError('Tunnel token file is empty or malformed.')
        network = {
            'provider': 'cloudflare',
            'hostname': host,
            'tunnelId': tunnel_id,
            'origin': 'http://127.0.0.1:8300',
            'credentialRef': str(manage.ROOT / TOKEN_RELATIVE_PATH),
            'cloudflaredBinary': binary,
            'cloudflaredVersion': '.'.join(map(str, version)),
            'metricsPort': metrics_port(),
        }
        new_origin = 'https://' + host
    else:
        if args.tunnel_id or args.token_file or args.cloudflared:
            raise ValueError('Cloudflare options can only be used with network configure cloudflare.')
        host = hostname(args.hostname) if args.hostname else hostname(urllib.parse.urlsplit(old_settings.get('origin', '')).hostname or '')
        network = {'provider': 'tailscale', 'hostname': host}
        new_origin = 'https://' + host

    new_settings['origin'] = new_origin
    new_settings['network'] = network
    for project in new_projects:
        project['url'] = _replace_origin(project, new_origin)

    settings_file = manage.ROOT / 'manager.json'
    projects_file = manage.ROOT / 'projects.json'
    token_file = manage.ROOT / TOKEN_RELATIVE_PATH
    network_state = manage.ROOT / 'launchagents' / (CLOUDFLARED_LABEL + '.plist')
    network_agent = manage.AGENTS / (CLOUDFLARED_LABEL + '.plist')
    affected = [settings_file, projects_file, token_file, network_state, network_agent]
    for project in old_projects:
        for part in ['auth', 'bridge']:
            name = manage.label(project['slug'], part) + '.plist'
            affected.extend([manage.ROOT / 'launchagents' / name, manage.AGENTS / name])
    running = [manage.label(project['slug'], part) for project in old_projects if project.get('enabled', True)
               for part in ['auth', 'bridge'] if manage.loaded(manage.label(project['slug'], part))]
    cloudflared_running = manage.loaded(CLOUDFLARED_LABEL)
    transaction = _begin_transaction(manage, affected, running, cloudflared_running, old_projects,
                                     old_settings.get('network') or {})

    try:
        (manage.ROOT / 'launchagents').mkdir(parents=True, exist_ok=True, mode=0o700)
        manage.AGENTS.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in running:
            manage.stop(name)
        if cloudflared_running:
            manage.stop(CLOUDFLARED_LABEL)
        manage.atomic(settings_file, (json.dumps(new_settings, indent=2) + '\n').encode(), 0o600)
        manage.save(new_projects)
        for project in new_projects:
            for part in ['auth', 'bridge']:
                name = manage.label(project['slug'], part) + '.plist'
                data = manage.plist_for(project, part)
                manage.atomic(manage.ROOT / 'launchagents' / name, data, 0o644)
                agent = manage.AGENTS / name
                if project.get('enabled', True):
                    manage.atomic(agent, data, 0o644)
                else:
                    agent.unlink(missing_ok=True)
        if args.provider == 'cloudflare':
            token_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            manage.atomic(token_file, (token + '\n').encode(), 0o600)
            data = tunnel_plist(manage, network)
            manage.atomic(network_state, data, 0o644)
            manage.atomic(network_agent, data, 0o644)
        else:
            network_state.unlink(missing_ok=True)
            network_agent.unlink(missing_ok=True)

        for name in running:
            manage.launch('bootstrap', manage.DOMAIN, str(manage.AGENTS / (name + '.plist')))
            project, part = next((project, part) for project in new_projects for part in ['auth', 'bridge']
                                 if manage.label(project['slug'], part) == name)
            manage.wait_health(project[part + 'Port'])
        if args.provider == 'cloudflare':
            manage.launch('bootstrap', manage.DOMAIN, str(network_agent))
            wait_ready(network)
        manage.atomic(transaction / 'committed', b'yes', 0o600)
    except Exception:
        recover(manage)
        raise
    _finish_transaction(transaction)
    print(f"Network provider configured: {args.provider} ({host}). Project paths and local credentials preserved.")
    if args.provider == 'cloudflare':
        print('Cloudflare DNS and the Tunnel public-hostname route must already point to this hostname and http://127.0.0.1:8300.')
        print('Update MCP clients to the new project URLs if the public hostname changed, then reconnect for OAuth discovery.')


def status(manage, projects):
    settings = manage.settings()
    config = settings.get('network') or {}
    provider = config.get('provider', 'external')
    host = config.get('hostname') or urllib.parse.urlsplit(settings.get('origin', '')).hostname or 'unconfigured'
    print(f'provider: {provider}')
    print(f'hostname: {host}')
    if provider == 'cloudflare':
        print(f"tunnel-id: {config.get('tunnelId', 'missing')}")
        try:
            binary = cloudflared_binary(configured=config.get('cloudflaredBinary'))
            version = cloudflared_version(binary)
            print(f'cloudflared: {".".join(map(str, version))}')
        except ValueError as error:
            print(f'cloudflared: unavailable ({error})')
        print(f"tunnel-process: {'loaded' if manage.loaded(CLOUDFLARED_LABEL) else 'not loaded'}")
        print(f"tunnel-ready: {'yes' if ready(config) else 'no'}")
    elif provider == 'tailscale':
        print('publishing: externally managed')
    else:
        print('publishing: externally managed; use titian network configure to record a provider')
    print(f'projects: {sum(1 for project in projects if project.get("enabled", True))} enabled')


def doctor(manage, projects):
    settings = manage.settings()
    config = settings.get('network') or {}
    provider = config.get('provider', 'external')
    failed = False
    print(f'provider={provider}')
    if not settings.get('origin'):
        print('origin=FAIL (run titian init --origin https://your-host.example)')
        failed = True
    else:
        print('origin=OK')
    if provider == 'cloudflare':
        try:
            binary = cloudflared_binary(configured=config.get('cloudflaredBinary'))
            version = cloudflared_version(binary)
            print(f"cloudflared={'.'.join(map(str, version))} (OK)")
        except ValueError as error:
            print(f'cloudflared=FAIL ({error})')
            failed = True
        running = manage.loaded(CLOUDFLARED_LABEL)
        print(f"tunnel-process={'OK' if running else 'FAIL'}")
        if not running:
            failed = True
        connected = running and ready(config)
        print(f"tunnel-connected={'OK' if connected else 'FAIL'}")
        if not connected:
            failed = True
        if config.get('hostname') != urllib.parse.urlsplit(settings.get('origin', '')).hostname:
            print('hostname-origin=FAIL')
            failed = True
        else:
            print('hostname-origin=OK')
    else:
        print('provider-process=external')
    if failed:
        message = 'Network provider checks failed. See the status above.'
        if provider == 'cloudflare':
            message += f' Inspect {manage.ROOT / "logs/cloudflared.err.log"}.'
        raise RuntimeError(message)
    # Reuse the project doctor for independent local and public endpoint checks.
    import argparse
    manage.doctor(argparse.Namespace(project='all', public=True), projects)
