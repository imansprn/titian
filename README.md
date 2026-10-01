# Titian

[![CI](https://github.com/imansprn/titian/actions/workflows/ci.yml/badge.svg)](https://github.com/imansprn/titian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/imansprn/titian)](LICENSE)

**Connect your local workspaces to remote MCP clients through one authenticated gateway.** Titian runs Desktop Commander on your Mac and gives each project its own URL, OAuth credentials and folder configuration.

For example, connect a mobile app and a backend as two separate MCP connections, or give one connection access to both folders. Clients can read project metadata to identify the configured project and roots. One project uses the same installation as many.

Titian means a narrow footbridge in Indonesian.

> Desktop Commander can read files and run commands with your account's permissions. Project folders are not an OS sandbox. Read [SECURITY.md](SECURITY.md) before exposing the gateway.

## Documentation

| Guide | What it covers |
|---|---|
| [Permissions and approvals](docs/permissions.md) | Presets, task templates, custom rules, owner approval and migration. |
| [Operations](docs/operations.md) | Installation, service lifecycle, runtime updates and validation. |
| [Troubleshooting](docs/troubleshooting.md) | Connection failures, blocked operations and approval errors. |
| [Architecture](docs/architecture.md) | Gateway, authentication, policy enforcement and execution. |
| [Security](SECURITY.md) | Host-execution risks and the limits of permission controls. |

## Before you start

You need:

- **macOS**, Python **3.10+**, Node.js **22+**, npm and Git. The service manager uses macOS launchd; Linux is currently covered for protocol tests, not service management.
- An MCP client that supports remote Streamable HTTP and OAuth dynamic registration.
- A public HTTPS hostname forwarding to this Mac. The walkthrough uses an installed, signed-in Tailscale client with [Funnel enabled](https://tailscale.com/docs/features/tailscale-funnel). You can use your own HTTPS reverse proxy instead.
- An existing project folder. Titian configures access to it; it does not create or clone your application.

Keep the Mac awake and online while connecting remotely.

## 1. Choose your HTTPS origin

Find your machine's Tailscale DNS hostname:

```sh
tailscale status --json | python3 -c 'import json,sys; print("https://" + json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
```

The result looks like `https://my-mac.my-tailnet.ts.net`. Copy your actual result; do not use this example hostname.

Your **origin** is the HTTPS scheme and hostname, without `/mcp` or a project path. With another reverse proxy, use the HTTPS origin you control. Configure it to preserve request paths and forward to `127.0.0.1:8300`.

## 2. Install and prepare Titian

```sh
git clone https://github.com/imansprn/titian.git
cd titian
npm ci
```

Replace the hostname below with the origin from step 1:

```sh
./bin/titian init --origin https://my-mac.my-tailnet.ts.net
./bin/titian runtime install
```

`init` creates private local settings in `.titian/`. `runtime install` builds the pinned Desktop Commander runtime. Neither command exposes the Mac publicly.

## 3. Start the gateway and add your first project

Run `init` again with `--start-gateway` to install and start the macOS gateway service. Repeating `init` preserves your state:

```sh
./bin/titian init --origin https://my-mac.my-tailnet.ts.net --start-gateway
```

Replace `/absolute/path/to/project` with an existing directory:

```sh
./bin/titian add "My app" /absolute/path/to/project --slug my-app
```

This starts the project's local bridge and OAuth proxy with read-only permissions by default. The command prints its connection URL and PIN file path. The URL will have this shape:

```text
https://my-mac.my-tailnet.ts.net/projects/my-app/mcp
```

For the Tailscale setup, publish the gateway:

```sh
tailscale funnel --bg 8300
```

Follow any Funnel authorization instructions it prints. With your own HTTPS reverse proxy, activate the forwarding configured in step 1 instead.

## 4. Connect your MCP client

Use these settings in a client that supports remote MCP with OAuth:

| Setting | Value |
|---|---|
| Server URL | The full `/projects/my-app/mcp` URL printed by `add` |
| Authentication | OAuth, with dynamic client registration |
| Client ID / secret | Not supplied manually; the client registers itself |
| Consent | Enter this project's PIN in the authorization page |

Read the PIN locally, from the Titian repository root:

```sh
cat .titian/instances/my-app/.oauth-consent-pin
```

The PIN is **not** a bearer token or client secret. Enter it only in the consent page for the connection you initiated. After approval, the client receives and refreshes its own tokens. Menu names differ between clients; use their remote MCP connection settings.

## 5. Check that it worked

```sh
./bin/titian list
./bin/titian doctor
```

Example output (your paths and hostname differ):

```text
my-app — My app (active)
  https://my-mac.my-tailnet.ts.net/projects/my-app/mcp
  /absolute/path/to/project

my-app: auth=OK, bridge=OK, oauth-routing=OK, mcp=OK
```

`doctor` checks local services and MCP routing. For a separate public endpoint check, run `./bin/titian doctor --public`.

In your connected client, ask it to call `titian_project_info`. It should return the project name and roots you configured. Tool and resource availability depends on the client's MCP support.

## Use `titian` from any directory

The walkthrough uses `./bin/titian`, which does not require PATH changes. To use the shorter command, run these from the Titian root:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$(pwd)/bin/titian" "$HOME/.local/bin/titian"
export PATH="$HOME/.local/bin:$PATH"
titian list
```

Add the `export PATH` line to your shell configuration, such as `~/.zshrc`, to keep it across terminals. If the symlink already exists, inspect its target before replacing it.

## Multiple projects and metadata

Each `add` creates a separate URL and credentials. To give one project two roots and descriptive labels:

```sh
titian add "Web and mobile" /path/to/backend /path/to/mobile \
  --slug example --capabilities mobile backend git test build
```

After authentication, clients can read the MCP resource `titian://project/metadata` or call the read-only tool `titian_project_info`:

```json
{
  "project": "example",
  "roots": ["/path/to/backend", "/path/to/mobile"],
  "capabilities": ["mobile", "backend", "git", "test", "build"]
}
```

Capabilities are labels you configure, not permissions, detected frameworks, or guarantees that a build command exists. They default to `[]`. Local paths are returned through the authenticated MCP connection, not public OAuth discovery metadata.

## Permissions and owner approvals

New workspaces default to `readonly`. Presets control operations, not command-name prefixes:

| Preset | Use it for | Key behavior |
|---|---|---|
| `readonly` | Browsing and searching selected files. | No file changes or shell execution, including `git status` or `pwd`. |
| `editor` | Creating and editing selected files. | Moves/renames ask; shell execution, URL retrieval and rich rendering remain denied. |
| `custom` | Explicit operation rules. | Each operation is `allow`, `ask` or `deny`; unspecified rules deny. |
| `unrestricted` | Explicitly trusted host workflows. | Reviewed operations run without routine Titian approval; authentication, file scope and backend restrictions still apply. |

**No preset is an OS sandbox.** `editor` allows overwriting existing files; it is not a create-only preset. DOCX/PDF generation additionally requires `document.render` and is not included in `editor`.

Task templates are separate from permission levels. `documents` selects `editor`; `developer` and `data-analysis` select custom rules and **ask before starting a process or sending interactive input**. The developer template also asks before system inspection. Templates do not guess whether `npm test` or another command is harmless. See the [complete preset matrix](docs/permissions.md#preset-reference).

```sh
titian update example --permissions editor
titian update example --template developer
titian update example --permissions custom --allow files.read --ask process.start
titian permissions example
```

`titian permissions` shows configured and verified effective policy separately. An offline or older runtime is reported as unverified, not protected. Changing source code alone does not activate a new runtime.

When a tool returns `approval_required`, review it on the Mac in an interactive owner terminal:

```sh
titian approvals example list
titian approvals example show REQUEST_ID
titian approvals example approve REQUEST_ID
# Or: titian approvals example reject REQUEST_ID
```

Titian executes an `allow` request, queues an `ask` request without executing it, and rejects a `deny` request without an approve-once shortcut. There is no MCP tool for approving requests or changing the policy; those decisions belong in the local owner interface.

**Approving does not execute the operation.** After local approval, the same authenticated client explicitly calls the MCP tool `titian_resume` with these arguments (replace the placeholder with the returned request ID):

```json
{ "requestId": "REQUEST_ID" }
```

The request expires five minutes after it was created, even if approved later. Approval is single-use and bound to the stored request and client; it never enables that command globally. A backend `blockedCommands` rejection remains a rejection. This release uses a local CLI, not a browser approval dialog or MCP elicitation. See [blocked commands and approval errors](docs/permissions.md#blocked-commands-and-approval-errors).

For an existing installation, [migrate explicitly](docs/permissions.md#migration-and-activation) before changing policy. Full operation definitions and limitations: [permissions](docs/permissions.md).

```sh
titian update example --capabilities mobile backend git test build
titian update example /path/to/new-root
titian restart example
titian disable example
titian enable example
titian remove example
```

Removing a project archives its OAuth state and stops its services. It never deletes the project's source folders. See [operations](docs/operations.md) for updates, recovery and runtime maintenance.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `titian: command not found` | Use `./bin/titian` from the repository root, or check the symlink and PATH above. |
| Gateway is not running | Run `./bin/titian status`; start it with `init --origin YOUR_ORIGIN --start-gateway`. |
| Local `doctor` passes but the client cannot connect | Check your HTTPS hostname, `tailscale funnel status`, and that the Mac is awake. Run `doctor --public`; if only one public IP fails, see [troubleshooting](docs/troubleshooting.md#doctor---public-fails-on-one-public-ip). |
| OAuth approval fails | Use the PIN for that project's slug and retry the connection from the client. |
| Runtime is missing | Run `npm ci`, then `./bin/titian runtime install`. |

Service logs are in `.titian/logs/`. Keep the repository at its installed path while services run; see [migration](docs/migration.md) before moving it.

## Architecture and development

```text
MCP client → HTTPS → gateway :8300
                       ├── project A → OAuth proxy → MCP bridge → Desktop Commander
                       └── project B → OAuth proxy → MCP bridge → Desktop Commander
```

Source is in `src/`, the CLI in `bin/`, and machine state in ignored `.titian/`. There is one root dependency graph and one project management flow.

```sh
npm ci
npm test
npm run test:manager
npm run test:dependencies
npm audit
```

CI checks Linux Node 22/24/26 and macOS Node 24, including runtime construction. Live integration tests are opt-in: [operations](docs/operations.md). More detail: [architecture](docs/architecture.md), [migration](docs/migration.md), [troubleshooting](docs/troubleshooting.md), and [security](SECURITY.md).

## License

[MIT](LICENSE). Dependencies retain their own licenses.
