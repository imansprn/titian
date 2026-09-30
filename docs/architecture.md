# Unified Titian architecture

Titian is a project manager with one gateway and one installation. A single project uses the same architecture as many projects.

```
titian/
  bin/titian                 public CLI
  src/gateway/server.cjs     HTTPS upstream routing
  src/auth/proxy.cjs         shared OAuth validation
  src/bridge/server.mjs      project-aware MCP bridge
  src/bridge/stdio.cjs       child process lifecycle
  src/bridge/policy.cjs      reviewed tool operations and scoped decisions
  src/bridge/approvals.cjs   single-use approval gate and local owner socket
  src/bridge/identity.cjs    authenticated execution identity
  src/bridge/permissions.json shared presets, operations and task templates
  src/manager/permissions.py owner policy and approval CLI
  src/manager/manage.py      registry and launchd management
  src/manager/runtime.py     pinned runtime build/install
  tests/                     unit and integration checks
  docs/                      architecture, operation, migration, troubleshooting
  package.json               one dependency graph and scripts
  .titian/                   ignored machine state and generated runtime
```

The gateway listens on loopback port 8300. Projects have independent auth and bridge processes, credentials, and root configuration. Normal project URLs are `/projects/<slug>/mcp`. Migrated root `/mcp` connections retain their issuer and credentials as a managed compatibility project, without a separate installation flow.

The bridge uses stateless Streamable HTTP. Every POST gets a fresh MCP server/transport that forwards to the project's long-lived Desktop Commander stdio process. Titian does not persist or require `Mcp-Session-Id`; optional GET SSE streams and DELETE session termination return HTTP 405. This keeps client requests valid across bridge restarts, except for calls that were already in flight when the process stopped.

The CLI is `titian init`, `titian add`, `titian list`, `titian doctor`, and the other lifecycle commands. `titian runtime install` installs a first runtime; `titian runtime update` rebuilds and restarts active services. Dependencies are installed once at the repository root.

Machine state lives in `.titian/`: manager settings, project registry, instances, logs, launch agent copies, archives, and generated runtime. Source paths are never inferred from the state directory. `TITIAN_DATA_DIR` can select another state location. Moving a running installation requires rewriting its installed service paths.

Project root restrictions are not an operating-system sandbox. Terminal tools still have the permissions of the signed-in user.

The bridge checks authenticated identity before dispatch, evaluates the operation policy and either forwards, returns a hard denial, or stores a pending approval. The owner CLI approves through a local Unix socket; the client explicitly resumes the stored request. No approval endpoint is exposed through MCP or HTTP. Pending approvals and client-owned process/search sessions are invalidated on bridge restart. Policy configuration is stored in the registry and copied into service environments; live effective policy is verified separately.

This does not introduce multi-user OS isolation. Host execution can reach resources beyond structured file-tool scope. See [permissions](permissions.md) for the trust boundary, migration, and supported operations.
