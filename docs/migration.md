# Migration from the split layout

## Intended result

Remove `project-mcp/` and `http-bridge/` from the active repository. Move their source into `src/`, tests into `tests/`, and dependencies into the root package. All user-facing documentation and commands use Titian.

## Migration sequence

1. Save the existing repository and installed launch agent configurations privately.
2. Refactor source and documentation; test the new layout without changing live service state.
3. Build the new pinned runtime.
4. Stop existing services and copy the latest OAuth state into `.titian/instances/`.
5. Import existing project definitions, ports, and URLs. Import the root `/mcp` connection as a managed compatibility project with its existing issuer and credentials.
6. Generate `com.titian.*` launch agents and switch the CLI links to `bin/titian`. Retain `mcp-project` as a compatibility command alias.
7. Start services, verify health, OAuth, root isolation checks and CLI lifecycle behavior. Restore previous service configurations if activation fails.
8. Move the old operational folders into the private migration backup. Publish only source changes after tests and credential checks pass.

## Compatibility and rollback

Existing URLs and credentials remain valid. The MCP bridge is stateless, so there is no in-memory HTTP session to restore after restart; only calls already in flight need to be retried. Credentials are not mass-rotated by this migration. Backups contain private OAuth state and must never be published.

Rollback restores the saved launch agents, registry, source layout and runtime from the private backup. Do not run old and new installations simultaneously against the same ports or OAuth state.
