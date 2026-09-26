# Per-project MCP on macOS

Run separate Desktop Commander instances with their own OAuth state, project roots and MCP URLs. This is project separation, not an OS sandbox: terminal tools run with your user account's permissions.

## Requirements

- macOS with launchd, Python 3.10+, Node.js 22+ and npm.
- A public HTTPS origin forwarding to the loopback gateway on port 8300.
- This repository must remain at its installed path while services run.

## First installation

From the repository root:

```sh
npm ci --prefix project-mcp/dependencies
./project-mcp/mcp-project init --origin https://your-host.example
python3 project-mcp/setup.py --install
./project-mcp/mcp-project init --origin https://your-host.example --start-gateway
./project-mcp/mcp-project add "My project" /absolute/path/to/project
```

`init` creates an empty registry, state directories and gateway configuration. Repeating it preserves existing projects and credentials. Pass `--node /absolute/path/to/node` if Node is not discoverable on PATH. Local settings live in ignored `manager.json`; real project roots live in ignored `projects.json`.

Publish port 8300 with your TLS proxy, for example `tailscale funnel --bg 8300`. The command above starts local services only; HTTPS publishing is a separate step. Root `/mcp` traffic is forwarded to the optional main proxy on port 8000, configured using the root README. Project routes work without that main proxy.

Add the printed project URL to your MCP client using OAuth and approve with the PIN in `project-mcp/instances/<slug>/.oauth-consent-pin`. No manually supplied client secret is needed.

Optionally put the launcher on PATH:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$(pwd)/project-mcp/mcp-project" "$HOME/.local/bin/mcp-project"
```

The launcher resolves its symlink and finds the manager relative to itself.

## Operations

```sh
mcp-project list
mcp-project status
mcp-project doctor
mcp-project add "Web and mobile" /path/to/web /path/to/mobile --slug example
mcp-project add "Preview" /path/to/project --dry-run
mcp-project update example /path/to/new-root
mcp-project disable example
mcp-project enable example
mcp-project restart example
mcp-project remove example --dry-run
mcp-project remove example
mcp-project recover
```

Removal stops services and archives their state; it never deletes project source folders. Remove the corresponding client connection yourself. Re-adding a removed slug creates fresh credentials. Add/update/remove transactions roll back on failure and preserve unrelated projects. Logs are in `project-mcp/logs/`.

Do not change the configured origin without planning new client registrations. Existing project URLs are checked before `init` accepts an origin.

## Updating the runtime

```sh
npm ci --prefix project-mcp/dependencies
python3 project-mcp/setup.py             # build validation only
python3 project-mcp/setup.py --activate  # install and restart active project services
```

The runtime is built from pinned Desktop Commander and MCP SDK packages. The build validates the upstream config patch before activation. `--install` refuses to overwrite an existing runtime. `--activate` preserves the previous runtime for rollback. The auth entry point shares the root proxy implementation to keep validation consistent.

Dependency overrides select patched sharp and uuid versions. Verify image processing, spreadsheet round trips, and runtime startup when changing them. See the committed smoke test.

## Development

The following checks use temporary state and do not start production services:

```sh
python3 project-mcp/test_failures.py
python3 project-mcp/test_bootstrap.py
node project-mcp/test-dependencies.cjs
```

`python3 project-mcp/verify.py` tests running project services, including OAuth, routing, root access and terminal cwd. It creates verification clients in local OAuth state. It does not modify project source files.
