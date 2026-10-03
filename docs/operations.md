# Operating Titian

## Configuration

`titian init --origin https://your-host.example` creates local settings and state. Pass `--node /absolute/path/to/node` if Node is not on PATH. Initialization preserves existing credentials and refuses to silently change existing project issuers.

The default data directory is `.titian/` at the repository root. Set `TITIAN_DATA_DIR` to an absolute path before running CLI commands to use another location. The chosen state location is included in generated service configuration. `MCP_NODE_BIN` overrides the Node executable. `.env.example` describes these optional variables; the CLI reads environment variables, not a dotenv file.

State includes `manager.json`, `projects.json`, `instances/`, `logs/`, `launchagents/`, `runtime/` and `archives/`. Keep this data private and back it up separately from source. Never commit OAuth state or upload a development `.git` directory.

## Commands

```sh
titian init --origin https://your-host.example
titian runtime install
titian init --origin https://your-host.example --start-gateway
titian add "Example" /absolute/project/path --slug example
titian add "Preview" /absolute/project/path --dry-run
titian list
titian status
titian doctor
titian doctor --public
titian update example /path/to/web /path/to/mobile
titian restart example
titian disable example
titian enable example
titian remove example --dry-run
titian remove example
titian recover
titian rotate-logs
```

The gateway listens on port 8300 and exposes health endpoints `/health` and `/healthz`. Project services listen only on loopback. `add` assigns free ports and starts services before publishing the new route. HTTPS publishing remains an explicit external step.

`titian doctor` checks each enabled project's local auth and bridge health, OAuth routing, and MCP initialization. Add `--public` to check the hostname from each project's configured URL against the public resolver at `1.1.1.1`, then check HTTPS reachability for each returned IPv4 address. The public request is unauthenticated and expects HTTP `401`; that is the expected response when the route is reachable but no credentials are supplied. The command does not change DNS or external publishing configuration.

Public checks run once per project. Projects that share one hostname repeat the same DNS check, so one failed lookup can appear as `public-dns=FAIL` on every project. If that happens, inspect the shared hostname and rerun the lookup before changing configuration; DNS failures can be transient. To check it directly, use the hostname shown by `titian list`:

```sh
dig +short @1.1.1.1 YOUR_HOSTNAME A
```

No address means that resolver returned no IPv4 (`A`) record at that time. Confirm the hostname and public DNS, then retry. `public-<ip>=FAIL` means DNS returned an address but HTTPS did not return the expected `401`; check the TLS certificate and that Tailscale Funnel or your reverse proxy forwards the configured project path to `http://127.0.0.1:8300`. A successful public check does not replace the local auth, bridge, OAuth-routing, or MCP checks. Diagnose those failures separately with `titian doctor`, `titian status`, and the relevant service logs.

The first project root is the default terminal directory. Multiple roots share one project's credentials and processes. Project-specific Desktop Commander config suppresses config mutation tools, but terminal commands still run as the OS user.

Removal preserves source directories and archives credentials. Remove the corresponding client connection yourself. Re-adding a removed slug creates fresh credentials. `recover` finishes or rolls back an interrupted manager transaction.

## Runtime updates

From the repository root:

```sh
npm ci
titian runtime check
titian runtime update
```

For workspaces created before permission version 2, choose their initial permissions explicitly:

```sh
titian runtime update --legacy-permissions readonly
# Then choose a broader task policy only for the intended workspace:
titian update example --template developer
```

The old `--command-mode` and `--allowed-commands` flags are removed. Legacy prefixes are never silently converted into broader operation grants. Existing credentials and URLs are retained. Without an explicit legacy choice, activation refuses before stopping services.

`check` builds and validates a temporary runtime without replacing the active one. `install` is for first use and refuses an existing runtime. `update` replaces the runtime, restarts active services, and retains the previous runtime for rollback. The HTTP bridge is stateless, so clients do not lose a stored MCP transport session across the restart. In-flight calls are interrupted, while pending approvals and process ownership are discarded. A lost response does not prove an operation had no side effects: inspect its outcome before retrying writes or execution, and obtain a new approval when required. For production dependency upgrades, schedule a maintenance window or stage dependencies before restarting services. See [approval error handling](permissions.md#blocked-commands-and-approval-errors).

## Tests

```sh
npm test
npm run test:manager
npm run test:dependencies
```

These checks use temporary state. The dependency smoke test verifies image processing and spreadsheet round trips against patched dependencies. Permission integration tests use a real HTTP bridge and local owner socket with a recording fixture executor; fixture commands never run on the host. `npm run test:permissions-runtime` additionally builds a temporary pinned runtime and exercises Desktop Commander on disposable files and harmless commands, without starting launchd or changing live services.

The following integration checks act on the live installation:

```sh
python3 tests/verify_live.py
python3 tests/test_lifecycle.py
```

Verification creates test OAuth clients but does not edit project source files. Lifecycle testing temporarily adds and removes a project and verifies its files survive removal. Existing projects remain intact.

## Migrated connections

A migrated root `/mcp` connection is represented by a project with `rootRoute: true` in the registry. Its issuer, ports and credentials are preserved. Transport migration retains its configured roots. Version-2 permission migration is a separate explicit choice and does not add OS isolation. New projects use `/projects/<slug>/mcp`.

The old `mcp-project` command may remain as a symlink to `titian` for compatibility. It is not a separate application. See [migration.md](migration.md) before moving a running checkout.

## Project metadata

Every authenticated MCP connection exposes a read-only `titian_project_info` tool and a `titian://project/metadata` resource. They return the same JSON object: `project` is the configured slug, `roots` is the configured folder list, and `capabilities` is a list of descriptive labels. Initialization instructions also include this metadata.

```sh
titian add "Example" /path/to/project --slug example --capabilities backend git test build
titian update example --capabilities backend git test build
titian update example --capabilities
```

The last command clears labels. Labels use lowercase letters, digits and hyphens. They are not OS permissions or MCP protocol capability declarations; no framework or command availability is inferred from a label. Changing metadata restarts the affected project's services while preserving its URL and credentials. Existing projects default to an empty capability list.

## Permissions and approvals

Use `titian update example --permissions readonly|editor|custom|unrestricted` to choose a preset (supply one value). Task templates use `--template developer|documents|data-analysis`. Custom policies accept repeatable `--allow`, `--ask`, and `--deny` operation flags or an owner-authored `--policy-file`.

```sh
titian update example --template developer
titian permissions example
titian approvals example list
titian approvals example show REQUEST_ID
titian approvals example approve REQUEST_ID
```

Owner decisions require an interactive terminal. They are sent to an account-owned Unix socket, never through MCP or a public HTTP endpoint. The owner reviews the exact request and types a confirmation. The assistant then calls `titian_resume`; approval itself does not execute anything. An explicit `deny` cannot be approved once.

Updates restart the project and discard outstanding approvals and session ownership. Add/update verifies the effective policy before reporting success; runtime or policy mismatches trigger rollback. `permissions` reports unverified for an offline/old runtime. No effective policy is inferred from the registry alone.

See [permission semantics, migration and limits](permissions.md). Metadata contains local paths, so it is served through the authenticated MCP channel, not public OAuth discovery documents.

## Network providers

Titian records the selected public endpoint provider and manages the local `cloudflared` process for Cloudflare Tunnel. Tailscale Funnel and other reverse proxies remain externally managed. The gateway stays bound to `127.0.0.1:8300`; external routes must target the gateway, never a project service.

```sh
titian network status
titian network doctor
titian network configure tailscale
```

`network configure tailscale` records the hostname from the existing `--origin`. Use `--hostname` to change it explicitly. Cloudflare requires an existing remotely managed Tunnel, public-hostname route to `http://127.0.0.1:8300`, a DNS record, and a token file:

```sh
titian network configure cloudflare \
  --hostname mcp.example.com \
  --tunnel-id YOUR-TUNNEL-UUID \
  --token-file /path/to/tunnel-token
```

Titian copies the token into the selected state directory's `secrets/` folder with owner-only permissions, installs a launch agent for the existing `cloudflared` binary, and waits for the tunnel to connect. `cloudflared` 2025.4.0 or later is required for token files. Titian does not create DNS records or Tunnel routes, or install/upgrade `cloudflared`; configure those externally first. Pass `--cloudflared /absolute/path/to/cloudflared` when it is not on `PATH`.

Changing the hostname updates project URLs and OAuth issuer metadata while preserving project paths and local OAuth credentials. Update each MCP client's server URL and reconnect so it discovers the new issuer. Use `titian network doctor` to check the local tunnel connection, project health, DNS, and public HTTPS endpoint. It does not mutate Cloudflare or Tailscale resources. See [cloudflare.md](cloudflare.md) for provider behavior and security details.
