# Security

## What you are exposing

This project puts [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP) on the public internet. Anyone who gets a valid token can **read and write any file and run any command as your OS user**. Treat a leaked token as a full compromise of that account.

## Security model

- The server is built for **a single user**. Anyone can register an OAuth client, but a client only gets tokens after someone approves it on the consent page with the **consent PIN**.
- Access tokens are HS256 JWTs valid for 24 hours. Refresh tokens are opaque, last 30 days, and are replaced on every use.
- PKCE (S256) is required for the authorization-code flow.
- All services listen on loopback. Expose only the gateway through your HTTPS reverse proxy; project authentication is enforced by the routed auth proxy.

## Recommendations

- Only approve a consent request that **you started** from ChatGPT or Claude. Never enter the PIN on a link someone sent you.
- Use a long random PIN. Keep `.oauth-*` and `.mcp-token` files at mode `0600`, and never commit them. They are stored under `.titian/instances/<slug>/`, which is ignored by Git.
- Prefer OAuth over the static `MCP_AUTH_TOKEN`. If you do use the static token, send it in the `Authorization` header rather than `?token=`, because query strings end up in logs and browser history.
- To revoke a project’s sessions, stop its services, delete its `.oauth-state.json`, and rotate its `.oauth-signing-key` and PIN before restarting. Repeat for every project when revoking all access.
- Consider running Desktop Commander as a dedicated low-privilege user, and use its `allowedDirectories` / `blockedCommands` config to limit what it can reach.

## Reporting a vulnerability

Please report vulnerabilities privately through **GitHub → Security → Report a vulnerability** on this repository, not in a public issue.

## Updating older installations

Versions before commit `50b28f4` accepted the `client_credentials` grant for dynamically registered clients. That allowed token issuance without owner consent. Update to the current version; this grant is now rejected. If you exposed an older version, stop the proxy, rotate `.oauth-signing-key`, and remove `.oauth-state.json` to revoke access and refresh tokens before restarting. Reconnect your OAuth clients afterward. Backups of these files remain sensitive.

Only publish intended Git branches or clean source archives. Local application snapshots, `.git` directories copied from development machines, service logs, and migration backups may contain secrets even when the release branch is clean.
