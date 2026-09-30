"""Local owner policy configuration and approval client (not an MCP tool)."""
import json
import os
from pathlib import Path
import socket
import stat
import sys

DEFINITIONS = json.loads((Path(__file__).resolve().parents[1] / 'bridge/permissions.json').read_text())


def validate(policy):
    if (not isinstance(policy, dict) or set(policy) != {'version', 'preset', 'rules'}
            or type(policy['version']) is not int or policy['version'] != 2
            or not isinstance(policy['preset'], str) or policy['preset'] not in DEFINITIONS['presets'] or not isinstance(policy['rules'], dict)):
        raise ValueError('Invalid permissions: expected version 2, preset and rules.')
    if policy['preset'] != 'custom' and policy['rules']:
        raise ValueError('Only custom permissions accept rule overrides.')
    for operation, decision in policy['rules'].items():
        if operation not in DEFINITIONS['operations'] or decision not in ['allow', 'ask', 'deny']:
            raise ValueError(f'Invalid permission rule: {operation}')
    return json.loads(json.dumps(policy))


def flags(parser):
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--permissions', choices=list(DEFINITIONS['presets']), help='Workspace permission preset; new workspaces default to readonly')
    group.add_argument('--template', choices=list(DEFINITIONS['templates']), help='Task template, not a separate permission level')
    group.add_argument('--policy-file', help='Owner-authored version-2 policy JSON')
    for decision in ['allow', 'ask', 'deny']:
        parser.add_argument('--' + decision, action='append', default=[], metavar='OPERATION', help='Set a custom operation rule; repeat to set more rules')


def configure(args, current=None):
    policy = current if current is not None else {'version': 2, 'preset': 'readonly', 'rules': {}}
    if getattr(args, 'permissions', None):
        policy = {'version': 2, 'preset': args.permissions, 'rules': {}}
    if getattr(args, 'template', None):
        policy = {'version': 2, **DEFINITIONS['templates'][args.template]}
    if getattr(args, 'policy_file', None):
        policy = json.loads(Path(args.policy_file).expanduser().read_text())
    policy = validate(policy)
    seen = set()
    for decision in ['allow', 'ask', 'deny']:
        for operation in getattr(args, decision, None) or []:
            if operation in seen:
                raise ValueError(f'Conflicting decisions for {operation}')
            seen.add(operation)
            policy['rules'][operation] = decision
    return validate(policy)


def require_runtime(root):
    try:
        version = json.loads((root / 'runtime/build.json').read_text()).get('permissionVersion')
    except (OSError, ValueError):
        version = None
    if version != 2:
        raise ValueError('Installed runtime cannot enforce version-2 permissions. Run titian runtime update --legacy-permissions readonly (or runtime install for first use).')


def owner_request(root, slug, message):
    target = root / 'instances' / slug / 'owner.sock'
    info = target.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Unsafe owner socket: expected an account-owned socket with mode 0600.')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(str(target))
        connection.sendall((json.dumps(message) + '\n').encode())
        result = b''
        while b'\n' not in result:
            chunk = connection.recv(65536)
            if not chunk:
                raise ValueError('Owner endpoint closed without responding.')
            result += chunk
            if len(result) > 64 * 1024 * 1024:
                raise ValueError('Owner response exceeded the size limit.')
        response = json.loads(result.split(b'\n', 1)[0])
        if 'error' in response:
            raise ValueError(response['error'])
        return response['result']


def effective_matches(project, effective):
    configured = validate(project['permissions'])
    base = configured['rules'] if configured['preset'] == 'custom' else DEFINITIONS['presets'][configured['preset']]
    expected_rules = {operation: base.get(operation, 'deny') for operation in DEFINITIONS['operations']}
    return (effective.get('version') == 2 and effective.get('policy') == configured
            and effective.get('roots') == project['roots'] and effective.get('rules') == expected_rules)


def verify_effective(root, project):
    effective = owner_request(root, project['slug'], {'action': 'policy'})
    if not effective_matches(project, effective):
        raise RuntimeError('Effective permission verification failed for ' + project['slug'])
    return effective


def show(root, project):
    configured = project.get('permissions')
    if configured is not None:
        configured = validate(configured)
    result = {'project': project['slug'], 'configured': configured, 'effective': None, 'activation': 'unverified'}
    try:
        effective = owner_request(root, project['slug'], {'action': 'policy'})
        result['effective'] = effective
        result['activation'] = 'active' if configured is not None and effective_matches(project, effective) else 'mismatch'
    except (OSError, ValueError) as error:
        result['detail'] = 'No verified version-2 runtime response: ' + str(error)
    print(json.dumps(result, indent=2))


def approvals(root, project, args):
    action = args.approval_action
    if action in ['approve', 'reject'] and (not sys.stdin.isatty() or not sys.stdout.isatty()):
        raise ValueError('Owner decisions require an interactive local terminal. There is no noninteractive approval flag.')
    message = {'action': action, 'requestId': args.request_id}
    if action in ['show', 'approve', 'reject']:
        if not args.request_id:
            raise ValueError('A request ID is required.')
        preview = owner_request(root, project['slug'], {**message, 'action': 'show'})
        # Escape terminal control characters in untrusted filenames/commands.
        print(json.dumps(preview, indent=2, ensure_ascii=True))
        if action == 'show':
            return
        print('Host execution is not sandboxed. Approval authorizes exactly this stored request once; it does not execute it now.')
        expected = action + ' ' + args.request_id
        if input(f'Type "{expected}" to confirm: ').strip() != expected:
            print('Cancelled; no decision changed.')
            return
        message['requestHash'] = preview['requestHash']
    print(json.dumps(owner_request(root, project['slug'], message), indent=2, ensure_ascii=True))
