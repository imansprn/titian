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
  docs/                      architecture, operation, migration
  package.json               one dependency graph and scripts
  .titian/                   ignored machine state and generated runtime
```

The gateway listens on loopback port 8300. Projects have independent auth and bridge processes, credentials, and root configuration. Normal project URLs are `/projects/<slug>/mcp`. Migrated root `/mcp` connections retain their issuer and credentials as a managed compatibility project, without a separate installation flow.

The CLI is `titian init`, `titian add`, `titian list`, `titian doctor`, and the other lifecycle commands. `titian runtime install` installs a first runtime; `titian runtime update` rebuilds and restarts active services. Dependencies are installed once at the repository root.

Machine state lives in `.titian/`: manager settings, project registry, instances, logs, launch agent copies, archives, and generated runtime. Source paths are never inferred from the state directory. `TITIAN_DATA_DIR` can select another state location. Moving a running installation requires rewriting its installed service paths.

Project root restrictions are not an operating-system sandbox. Terminal tools still have the permissions of the signed-in user.
