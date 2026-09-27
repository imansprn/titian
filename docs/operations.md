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

The first project root is the default terminal directory. Multiple roots share one project's credentials and processes. Project-specific Desktop Commander config suppresses config mutation tools, but terminal commands still run as the OS user.

Removal preserves source directories and archives credentials. Remove the corresponding client connection yourself. Re-adding a removed slug creates fresh credentials. `recover` finishes or rolls back an interrupted manager transaction.

## Runtime updates

From the repository root:

```sh
npm ci
titian runtime check
titian runtime update
```

`check` builds and validates a temporary runtime without replacing the active one. `install` is for first use and refuses an existing runtime. `update` replaces the runtime, restarts active services, and retains the previous runtime for rollback. For production dependency upgrades, schedule a maintenance window or stage dependencies before restarting services.

## Tests

```sh
npm test
npm run test:manager
npm run test:dependencies
```

These checks use temporary state. The dependency smoke test verifies image processing and spreadsheet round trips against patched dependencies.

The following integration checks act on the live installation:

```sh
python3 tests/verify_live.py
python3 tests/test_lifecycle.py
```

Verification creates test OAuth clients but does not edit project source files. Lifecycle testing temporarily adds and removes a project and verifies its files survive removal. Existing projects remain intact.

## Migrated connections

A migrated root `/mcp` connection is represented by a project with `rootRoute: true` in the registry. Its issuer, ports and credentials are preserved. If its previous filesystem access was unrestricted, migration keeps that access; it does not claim to add isolation. New projects use `/projects/<slug>/mcp`.

The old `mcp-project` command may remain as a symlink to `titian` for compatibility. It is not a separate application. See [migration.md](migration.md) before moving a running checkout.

## Project metadata

Every authenticated MCP connection exposes a read-only `titian_project_info` tool and a `titian://project/metadata` resource. They return the same JSON object: `project` is the configured slug, `roots` is the configured folder list, and `capabilities` is a list of descriptive labels. Initialization instructions also include this metadata.

```sh
titian add "Example" /path/to/project --slug example --capabilities backend git test build
titian update example --capabilities backend git test build
titian update example --capabilities
```

The last command clears labels. Labels use lowercase letters, digits and hyphens. They are not OS permissions or MCP protocol capability declarations; no framework or command availability is inferred from a label. Changing metadata restarts the affected project's services while preserving its URL and credentials. Existing projects default to an empty capability list.

Metadata contains local paths, so it is served through the authenticated MCP channel. Do not publish it in OAuth discovery documents.
