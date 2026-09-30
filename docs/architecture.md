# Unified Titian architecture

Titian is a project manager with one gateway and one installation. A single project uses the same architecture as many projects.

```
titian/
  bin/titian                 public CLI
  src/gateway/server.cjs     HTTPS upstream routing
  src/auth/proxy.cjs         shared OAuth validation
  src/bridge/server.mjs      project-aware MCP bridge
  src/bridge/stdio.cjs       child process lifecycle
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
