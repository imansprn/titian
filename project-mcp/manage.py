#!/usr/bin/env python3
"""Manage native macOS project MCP services without editing configuration by hand."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.parse

ROOT = Path(__file__).resolve().parent
AGENTS = Path.home() / 'Library/LaunchAgents'
DOMAIN = f'gui/{os.getuid()}'
def settings():
    path = ROOT / 'manager.json'
    return json.loads(path.read_text()) if path.exists() else {}


def node_binary():
    binary = os.environ.get('MCP_NODE_BIN') or settings().get('node') or shutil.which('node')
    if not binary or not Path(binary).is_file():
        raise ValueError('Node.js not found. Set MCP_NODE_BIN to its absolute path.')
    return str(Path(binary).resolve())


def service_path():
    return str(Path(node_binary()).parent) + os.pathsep + os.environ.get('PATH', os.defpath)


def public_origin():
    origin = os.environ.get('MCP_PUBLIC_BASE') or settings().get('origin')
    if not origin and (ROOT / 'projects.json').exists():
        projects = load()
        if projects:
            url = urllib.parse.urlsplit(projects[0]['url'])
            origin = f'{url.scheme}://{url.netloc}'
    url = urllib.parse.urlsplit(origin or '')
    if url.scheme != 'https' or not url.hostname or url.path not in ['', '/'] or url.query or url.fragment or url.username or url.password:
        raise ValueError('Run mcp-project init --origin https://your-host.example first.')
    return origin.rstrip('/')


def initialize(args):
    url = urllib.parse.urlsplit(args.origin)
    if url.scheme != 'https' or not url.hostname or url.path not in ['', '/'] or url.query or url.fragment or url.username or url.password:
        raise ValueError('Origin must be an HTTPS origin without a path or credentials.')
    config = settings()
    origin = args.origin.rstrip('/')
    if config.get('origin') and config['origin'] != origin:
        raise ValueError('Existing origin differs; migrate existing client registrations before changing it.')
    if (ROOT / 'projects.json').exists():
        for project in load():
            if not project['url'].startswith(origin + '/'):
                raise ValueError('Existing project issuer differs; registry left unchanged.')
    if args.node:
        binary = Path(args.node).expanduser().resolve()
        if not binary.is_file(): raise ValueError('Node executable does not exist.')
        config['node'] = str(binary)
    config['origin'] = origin
    atomic(ROOT / 'manager.json', (json.dumps(config, indent=2) + '\n').encode())
    for name in ['instances', 'logs', 'launchagents', 'archives']:
        (ROOT / name).mkdir(exist_ok=True, mode=0o700)
    AGENTS.mkdir(parents=True, exist_ok=True)
    if not (ROOT / 'projects.json').exists(): save([])
    name = 'com.iman.project-mcp.gateway'
    data = plistlib.dumps({'Label': name, 'ProgramArguments': [node_binary(), str(ROOT / 'gateway.cjs')],
        'WorkingDirectory': str(ROOT), 'EnvironmentVariables': {'PATH': service_path()},
        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
        'StandardOutPath': str(ROOT / 'logs/gateway.log'), 'StandardErrorPath': str(ROOT / 'logs/gateway.err.log')})
    atomic(ROOT / 'launchagents' / (name + '.plist'), data, 0o644)
    if args.start_gateway:
        if sys.platform != 'darwin': raise ValueError('Starting launchd services requires macOS.')
        if loaded(name): raise ValueError('Gateway already running; existing service left unchanged.')
        atomic(AGENTS / (name + '.plist'), data, 0o644)
        launch('bootstrap', DOMAIN, str(AGENTS / (name + '.plist')))
        wait_health(8300)
    print('Initialized project manager. Existing project state preserved.')



def load():
    path = ROOT / 'projects.json'
    if not path.exists(): raise ValueError('Run mcp-project init --origin https://your-host.example first.')
    return json.loads(path.read_text())


def atomic(path, content, mode=0o600):
    temp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    try:
        temp.write_bytes(content)
        temp.chmod(mode)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def save(projects):
    atomic(ROOT / 'projects.json', (json.dumps(projects, indent=2) + '\n').encode(), 0o644)


def label(slug, part):
    return f'com.iman.project-mcp.{slug}.{part}'


def launch(*args, check=True):
    result = subprocess.run(['launchctl', *args], capture_output=True, text=True)
    # bootout can return while the previous process is still terminating.
    if args and args[0] == 'bootstrap':
        for _ in range(10):
            if result.returncode == 0: break
            time.sleep(0.5)
            result = subprocess.run(['launchctl', *args], capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or 'launchctl failed')
    return result


def loaded(name):
    return launch('print', f'{DOMAIN}/{name}', check=False).returncode == 0


def stop(name):
    if loaded(name):
        launch('bootout', f'{DOMAIN}/{name}')


def plist_for(project, part):
    slug = project['slug']
    inst = ROOT / 'instances' / slug
    if part == 'bridge':
        script = ROOT / 'runtime/bridge/bridge.js'
        cwd = project['roots'][0]
        env = {'MCP_BRIDGE_PORT': str(project['bridgePort']),
               'MCP_STDIO_WRAPPER': str(ROOT / 'runtime/dc-wrapper.js'),
               'DESKTOP_COMMANDER_BIN': str(ROOT / 'runtime/dc/dist/index.js'),
               'MCP_DC_CONFIG_DIR': str(inst), 'MCP_PROJECT_ROOT': cwd,
               'MCP_PROJECT_ROOTS': json.dumps(project['roots']),
               'MCP_PROJECT_SLUG': slug, 'MCP_SERVER_LABEL': project['name']}
    else:
        script = ROOT / 'runtime/auth-proxy.cjs'
        cwd = str(ROOT)
        env = {'MCP_PROXY_PORT': str(project['authPort']),
               'MCP_UPSTREAM_PORT': str(project['bridgePort']),
               'MCP_DATA_DIR': str(inst), 'MCP_PUBLIC_BASE': project['url'][:-4],
               'MCP_SERVER_LABEL': project['name']}
    name = label(slug, part)
    return plistlib.dumps({'Label': name, 'ProgramArguments': [node_binary(), str(script)],
                          'EnvironmentVariables': {'PATH': service_path(), **env}, 'WorkingDirectory': cwd,
                          'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
                          'StandardOutPath': str(ROOT / 'logs' / f'{name}.log'),
                          'StandardErrorPath': str(ROOT / 'logs' / f'{name}.err.log')})


def available(port):
    try:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False


def free_ports(projects):
    used = {p[k] for p in projects for k in ['bridgePort', 'authPort']}
    ports = []
    for port in range(8101, 9000):
        if port not in used and port not in [8300] and available(port):
            ports.append(port)
            if len(ports) == 2:
                return ports
    raise ValueError('Tidak ada port lokal tersedia dalam rentang 8101–8999.')


def make_project(name, paths, slug, projects):
    slug = slug or re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug) or slug in ['all', 'gateway']:
        raise ValueError('Slug harus berupa huruf kecil/angka dengan tanda hubung; all dan gateway dicadangkan.')
    if not name.strip():
        raise ValueError('Nama project tidak boleh kosong.')
    if any(p['slug'] == slug for p in projects):
        raise ValueError(f'Project {slug} sudah terdaftar.')
    roots = list(dict.fromkeys(str(Path(p).expanduser().resolve(strict=True)) for p in paths))
    if not roots or not all(Path(p).is_dir() for p in roots):
        raise ValueError('Semua path harus berupa folder yang sudah ada.')
    bridge, auth = free_ports(projects)
    return {'slug': slug, 'name': name.strip(), 'roots': roots, 'bridgePort': bridge, 'authPort': auth,
            'url': f'{public_origin()}/projects/{slug}/mcp'}


def wait_health(port):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.2)
    raise RuntimeError(f'Layanan port {port} belum siap; cek log di {ROOT / "logs"}.')


def add(args, projects):
    project = make_project(args.name, args.paths, args.slug, projects)
    slug = project['slug']
    inst = ROOT / 'instances' / slug
    if inst.exists():
        raise ValueError(f'State {inst} sudah ada; tidak ditimpa.')
    for part in ['bridge', 'auth']:
        name = label(slug, part)
        if loaded(name) or (AGENTS / f'{name}.plist').exists() or (ROOT / 'launchagents' / f'{name}.plist').exists():
            raise ValueError(f'Layanan {name} sudah ada; tidak ditimpa.')
    if args.dry_run:
        print(json.dumps(project, indent=2)); return
    for path in ['runtime/bridge/bridge.js', 'runtime/auth-proxy.cjs', 'runtime/dc/dist/index.js']:
        if not (ROOT / path).is_file():
            raise ValueError('Runtime belum tersedia. Jalankan setup.py terlebih dahulu.')
    tx = snapshot(projects, project)
    try:
        inst.mkdir(mode=0o700)
        template_file = Path.home() / '.claude-server-commander/config.json'
        template = json.loads(template_file.read_text()) if template_file.exists() else {}
        config = {k: v for k, v in template.items() if k not in ['usageStats', 'clientId']}
        config.update(allowedDirectories=project['roots'], telemetryEnabled=False,
                      pendingWelcomeOnboarding=False, welcomeOnboardingEligible=False)
        atomic(inst / 'config.json', json.dumps(config, indent=2).encode())
        for part in ['bridge', 'auth']:
            name = label(slug, part)
            for folder in [ROOT / 'launchagents', AGENTS]:
                file = folder / f'{name}.plist'
                atomic(file, plist_for(project, part), 0o644)
            launch('bootstrap', DOMAIN, str(AGENTS / f'{name}.plist'))
        wait_health(project['bridgePort']); wait_health(project['authPort'])
        # Publish the route only after both processes are healthy.
        save(projects + [project])
        atomic(tx / 'committed', b'yes')
    except Exception:
        recover()
        raise
    finish_transaction(tx, slug)
    print(f"Aktif: {project['name']} ({slug})\nURL: {project['url']}\nPIN: {inst / '.oauth-consent-pin'}")
    print('Tambahkan URL ini sebagai koneksi OAuth di ChatGPT dan selesaikan consent.')


def find_project(projects, slug):
    project = next((p for p in projects if p['slug'] == slug), None)
    if project is None:
        raise ValueError(f'Project {slug} tidak ditemukan.')
    return project


def snapshot(projects, project):
    """Persist recovery data before changing services, registry or files."""
    tx = ROOT / 'transaction'
    if tx.exists():
        raise RuntimeError('Transaksi belum selesai. Jalankan mcp-project recover.')
    stage = ROOT / 'transaction.tmp'
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(mode=0o700)
    record = {'projects': projects, 'project': project, 'new': not any(p['slug'] == project['slug'] for p in projects), 'loaded': [], 'files': {}}
    for part in ['auth', 'bridge']:
        name = label(project['slug'], part)
        if loaded(name): record['loaded'].append(name)
        for folder in [AGENTS, ROOT / 'launchagents']:
            file = folder / (name + '.plist')
            record['files'][str(file)] = file.read_text() if file.exists() else None
    config = ROOT / 'instances' / project['slug'] / 'config.json'
    record['files'][str(config)] = config.read_text() if config.exists() else None
    atomic(stage / 'record.json', json.dumps(record).encode())
    os.replace(stage, tx)
    return tx


def recover():
    tx = ROOT / 'transaction'
    if not tx.exists():
        print('Tidak ada transaksi tertunda.'); return
    rec = json.loads((tx / 'record.json').read_text())
    project = rec['project']; slug = project['slug']
    if (tx / 'committed').exists():
        finish_transaction(tx, slug)
        print('Transaksi yang sudah selesai dirapikan.'); return
    for part in ['auth', 'bridge']: stop(label(slug, part))
    archived = tx / 'state'
    inst = ROOT / 'instances' / slug
    if archived.exists():
        if inst.exists(): raise RuntimeError('State project dan arsip keduanya ada; perlu pemeriksaan manual.')
        os.replace(archived, inst)
    for filename, content in rec['files'].items():
        file = Path(filename)
        if content is None: file.unlink(missing_ok=True)
        else: atomic(file, content.encode(), 0o600 if file.name == 'config.json' else 0o644)
    for name in rec['loaded']:
        launch('bootstrap', DOMAIN, str(AGENTS / (name + '.plist')))
    if rec['loaded']:
        wait_health(project['bridgePort']); wait_health(project['authPort'])
    save(rec['projects'])
    if rec.get('new') and inst.exists():
        failed = ROOT / 'archives' / f'{slug}-failed-{time.time_ns()}'
        failed.parent.mkdir(exist_ok=True, mode=0o700)
        os.replace(inst, failed)
    shutil.rmtree(tx)
    print('Transaksi dipulihkan ke kondisi sebelumnya.')


def finish_transaction(tx, slug):
    archive = ROOT / 'archives' / f'{slug}-{time.time_ns()}'
    archive.parent.mkdir(exist_ok=True, mode=0o700)
    os.replace(tx, archive)
    return archive


def change(args, projects):
    project = find_project(projects, args.project)
    updated = dict(project)
    if args.action == 'update':
        if args.name: updated['name'] = args.name.strip()
        if not updated['name']: raise ValueError('Nama tidak boleh kosong.')
        if args.paths:
            updated['roots'] = list(dict.fromkeys(str(Path(v).expanduser().resolve(strict=True)) for v in args.paths))
            if not all(Path(v).is_dir() for v in updated['roots']): raise ValueError('Path harus folder.')
    elif args.action in ['enable', 'disable']:
        updated['enabled'] = args.action == 'enable'
    if args.dry_run:
        print(json.dumps({'action': args.action, 'project': updated}, indent=2)); return
    tx = snapshot(projects, project)
    try:
        # Hide the route while its services/configuration are being changed.
        save([dict(p, enabled=False) if p['slug'] == args.project else p for p in projects])
        for part in ['auth', 'bridge']: stop(label(args.project, part))
        if args.action == 'remove':
            inst = ROOT / 'instances' / args.project
            if inst.exists(): os.replace(inst, tx / 'state')
            for part in ['auth', 'bridge']:
                for folder in [AGENTS, ROOT / 'launchagents']:
                    (folder / (label(args.project, part) + '.plist')).unlink(missing_ok=True)
            final = [p for p in projects if p['slug'] != args.project]
        else:
            configfile = ROOT / 'instances' / args.project / 'config.json'
            config = json.loads(configfile.read_text()); config['allowedDirectories'] = updated['roots']
            atomic(configfile, json.dumps(config, indent=2).encode())
            for part in ['auth', 'bridge']:
                name = label(args.project, part)
                local = ROOT / 'launchagents' / (name + '.plist')
                atomic(local, plist_for(updated, part), 0o644)
                installed = AGENTS / (name + '.plist')
                if updated.get('enabled', True):
                    atomic(installed, local.read_bytes(), 0o644)
                    launch('bootstrap', DOMAIN, str(installed))
                else: installed.unlink(missing_ok=True)
            if updated.get('enabled', True):
                wait_health(updated['bridgePort']); wait_health(updated['authPort'])
            final = [updated if p['slug'] == args.project else p for p in projects]
        save(final)
        atomic(tx / 'committed', b'yes')
    except Exception:
        recover()
        raise
    archive = finish_transaction(tx, args.project)
    print(f'{args.action}: {args.project} selesai. Folder project tetap utuh.')
    if args.action == 'remove':
        print(f'Arsip: {archive}\nHapus koneksi terkait di ChatGPT jika tidak digunakan lagi.')
    else: print('URL, PIN, dan state OAuth dipertahankan.')


def remove(args, projects):
    args.action = 'remove'
    change(args, projects)


def doctor(args, projects):
    selected = projects if args.project == 'all' else [find_project(projects, args.project)]
    failures = 0
    for p in selected:
        if not p.get('enabled', True):
            print(f"{p['slug']}: disabled"); continue
        checks = []
        for part in ['auth', 'bridge']:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{p[part + 'Port']}/healthz", timeout=3) as r:
                    checks.append((part, r.status == 200))
            except OSError: checks.append((part, False))
        try:
            # No credentials or project data leave the machine in this diagnostic.
            path = '/.well-known/oauth-protected-resource/projects/' + p['slug'] + '/mcp'
            with urllib.request.urlopen('http://127.0.0.1:8300' + path, timeout=3) as r:
                checks.append(('oauth-routing', json.load(r)['resource'] == p['url']))
            data = json.dumps({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'doctor','version':'1'}}}).encode()
            req = urllib.request.Request(f"http://127.0.0.1:{p['bridgePort']}/mcp", data=data, headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'})
            with urllib.request.urlopen(req, timeout=5) as r:
                body = r.read().decode(); sid = r.headers.get('Mcp-Session-Id')
                msg = json.loads(next((line[6:] for line in body.splitlines() if line.startswith('data: ')), body))
                checks.append(('mcp', msg.get('result',{}).get('serverInfo',{}).get('name') == p['slug']))
            if sid:
                req = urllib.request.Request(f"http://127.0.0.1:{p['bridgePort']}/mcp", method='DELETE',headers={'Mcp-Session-Id':sid})
                with urllib.request.urlopen(req,timeout=3): pass
        except (OSError, ValueError, KeyError): checks.append(('mcp/oauth', False))
        if args.public:
            # Force public DNS to avoid a false positive through MagicDNS.
            host = urllib.parse.urlsplit(p['url']).hostname
            dns = subprocess.run(['dig','+short','@1.1.1.1',host,'A'],capture_output=True,text=True,timeout=10)
            ips = [line for line in dns.stdout.splitlines() if re.fullmatch(r'(?:[0-9]{1,3}\.){3}[0-9]{1,3}', line)]
            if not ips: checks.append(('public-dns', False))
            for ip in ips:
                r = subprocess.run(['curl','-sS','--connect-timeout','5','--max-time','10','--resolve',f'{host}:443:{ip}','-o','/dev/null','-w','%{http_code}',p['url']],capture_output=True,text=True,timeout=12)
                checks.append((f'public-{ip}', r.returncode == 0 and r.stdout == '401'))
        print(p['slug'] + ': ' + ', '.join(k+'='+('OK' if ok else 'FAIL') for k,ok in checks))
        failures += sum(not ok for _,ok in checks)
    if failures: raise RuntimeError(f'{failures} pemeriksaan gagal.')


def rotate_logs(args):
    """Copy/truncate preserves the inode held open by launchd-managed processes."""
    import gzip
    cutoff = args.max_mb * 1024 * 1024
    if cutoff <= 0 or args.keep < 1: raise ValueError('max-mb dan keep harus positif.')
    for log in (ROOT / 'logs').glob('*.log'):
        if log.stat().st_size < cutoff: continue
        for index in range(args.keep, 0, -1):
            old = Path(str(log) + f'.{index}.gz')
            if index == args.keep: old.unlink(missing_ok=True)
            elif old.exists(): os.replace(old, Path(str(log) + f'.{index+1}.gz'))
        with log.open('rb') as source, gzip.open(str(log)+'.1.gz','wb') as dest:
            shutil.copyfileobj(source,dest)
        with log.open('r+b') as current: current.truncate(0)
        print('Rotated', log.name)


def status_or_restart(args, projects):
    if args.project not in ['all', 'gateway'] + [p['slug'] for p in projects]:
        raise ValueError(f'Project {args.project} tidak ditemukan.')
    labels = ['com.iman.project-mcp.gateway'] if args.project in ['all', 'gateway'] else []
    for project in projects:
        if args.project in ['all', project['slug']]:
            labels += [label(project['slug'], part) for part in ['auth', 'bridge']]
    for name in labels:
        if args.action == 'restart':
            if not loaded(name):
                print('Skipped (disabled or unloaded)', name); continue
            launch('kickstart', '-k', f'{DOMAIN}/{name}'); print('Restarted', name)
        else:
            result = launch('print', f'{DOMAIN}/{name}', check=False)
            details = [line.strip() for line in result.stdout.splitlines()
                       if line.startswith(('\tstate =', '\tpid =', '\tlast exit code ='))]
            print(name + ': ' + ('; '.join(details) if result.returncode == 0 else 'not loaded'))


def main():
    parser = argparse.ArgumentParser(description='Kelola MCP per project. Folder/kode project tidak dihapus.')
    sub = parser.add_subparsers(dest='action', required=True)
    init = sub.add_parser('init', help='Initialize local registry and gateway configuration')
    init.add_argument('--origin', required=True)
    init.add_argument('--node')
    init.add_argument('--start-gateway', action='store_true')
    sub.add_parser('list', help='Daftar nama, folder, dan URL project')
    add_parser = sub.add_parser('add', help='Tambah project; boleh lebih dari satu folder')
    add_parser.add_argument('name'); add_parser.add_argument('paths', nargs='+')
    add_parser.add_argument('--slug'); add_parser.add_argument('--dry-run', action='store_true')
    for action in ['remove', 'disable', 'enable', 'update']:
        p = sub.add_parser(action)
        p.add_argument('project'); p.add_argument('--dry-run', action='store_true')
        if action == 'update':
            p.add_argument('paths', nargs='*'); p.add_argument('--name')
    sub.add_parser('recover', help='Pulihkan operasi yang terputus')
    p = sub.add_parser('doctor'); p.add_argument('project', nargs='?', default='all'); p.add_argument('--public', action='store_true')
    p = sub.add_parser('rotate-logs'); p.add_argument('--max-mb', type=float, default=10); p.add_argument('--keep', type=int, default=5)
    for action in ['status', 'restart']:
        p = sub.add_parser(action); p.add_argument('project', nargs='?', default='all')
    args = parser.parse_args()
    with (ROOT / '.manage.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action == 'init': initialize(args); return
        if args.action == 'recover': recover(); return
        if (ROOT / 'transaction').exists(): recover()
        projects = load()
        if args.action == 'add': add(args, projects)
        elif args.action in ['remove','disable','enable','update']: change(args, projects)
        elif args.action == 'doctor': doctor(args, projects)
        elif args.action == 'rotate-logs': rotate_logs(args)
        elif args.action == 'list':
            for p in projects:
                print(f"{p['slug']} — {p['name']} ({'active' if p.get('enabled', True) else 'disabled'})\n  {p['url']}\n  " + '\n  '.join(p['roots']))
        else: status_or_restart(args, projects)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, RuntimeError) as error:
        print(f'Error: {error}', file=sys.stderr)
        sys.exit(1)
