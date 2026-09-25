# Security

## What you are exposing

This project puts [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP) on the public internet. Anyone who gets a valid token can **read and write any file and run any command as your OS user**. Treat a leaked token as a full compromise of that account.

## Security model

- The server is built for **a single user**. Anyone can register an OAuth client, but a client only gets tokens after someone approves it on the consent page with the **consent PIN**.
- Access tokens are HS256 JWTs valid for 24 hours. Refresh tokens are opaque, last 30 days, and are replaced on every use.
- PKCE (S256) is required for the authorization-code flow.
- The bridge listens on `127.0.0.1` only. The auth proxy is the only component that should be reachable from outside.

## Recommendations

- Only approve a consent request that **you started** from ChatGPT or Claude. Never enter the PIN on a link someone sent you.
- Use a long random PIN. Keep `.oauth-*` and `.mcp-token` files at mode `0600`, and never commit them. They are already in `.gitignore`.
- Prefer OAuth over the static `MCP_AUTH_TOKEN`. If you do use the static token, send it in the `Authorization` header rather than `?token=`, because query strings end up in logs and browser history.
- To revoke all sessions, stop the proxy, delete `.oauth-state.json`, and rotate `.oauth-signing-key` and the PIN.
- Consider running Desktop Commander as a dedicated low-privilege user, and use its `allowedDirectories` / `blockedCommands` config to limit what it can reach.

## Reporting a vulnerability

Please report vulnerabilities privately through **GitHub → Security → Report a vulnerability** on this repository, not in a public issue.
