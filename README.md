# Titian

[![CI](https://github.com/imansprn/titian/actions/workflows/ci.yml/badge.svg)](https://github.com/imansprn/titian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/imansprn/titian)](LICENSE)

Manage desktop MCP access for one project or many. Titian gives each project its own OAuth credentials, processes and folder configuration, behind one HTTPS gateway. Connect from ChatGPT, Claude, or another remote MCP client.

Titian means a narrow footbridge in Indonesian.

> Desktop Commander can read files and run commands with your account's permissions. Project folders are not an OS sandbox. Read [SECURITY.md](SECURITY.md) before exposing the gateway.

## Install

The service manager requires **macOS, Python 3.10+, Node.js 22+ and npm**. Core protocol tests also run on Linux.

```sh
git clone https://github.com/imansprn/titian.git
cd titian
npm ci
./bin/titian init --origin https://your-host.example
./bin/titian runtime install
./bin/titian init --origin https://your-host.example --start-gateway
./bin/titian add "My project" /absolute/path/to/project
```

Publish loopback port **8300** through your HTTPS proxy. With Tailscale Funnel, use your machine's HTTPS hostname as the origin above, then run:

```sh
tailscale funnel --bg 8300
```

Add the project URL printed by `titian add` to your MCP client using OAuth. Approve with the PIN in `.titian/instances/<slug>/.oauth-consent-pin`. Titian does not print secret values.

To use `titian` from any directory, add a symlink in a directory on PATH:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$(pwd)/bin/titian" "$HOME/.local/bin/titian"
```

## Manage projects

```sh
titian add "Web and mobile" /path/to/web /path/to/mobile --slug example
titian list
titian doctor
titian update example /path/to/new-root
titian disable example
titian enable example
titian restart example
titian remove example
```

Removing a project stops its services and archives its OAuth state. It never deletes the project's source folders. A single project uses exactly the same setup and commands.

## Architecture

```text
MCP clients → HTTPS → gateway :8300
                       ├── project A → OAuth proxy → MCP bridge → Desktop Commander
                       └── project B → OAuth proxy → MCP bridge → Desktop Commander
```

Source is in `src/`, the CLI in `bin/`, and all dependencies in the root package. Local state and generated runtime live in ignored `.titian/`. Each project has its own `/projects/<slug>/mcp` URL. Existing root `/mcp` connections can be preserved during migration.

- [Operations and configuration](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Migration from the previous layout](docs/migration.md)
- [Security](SECURITY.md)

## Development

```sh
npm ci
npm test
npm run test:manager
npm run test:dependencies
npm audit
```

Tests use temporary state. Live lifecycle verification is opt-in; see the operations guide. CI checks Linux Node 22/24/26 and macOS Node 24, including first-install runtime construction.

## License

[MIT](LICENSE). Desktop Commander and other dependencies retain their own licenses.
