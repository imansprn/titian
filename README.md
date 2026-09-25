# titian

*titian* (Indonesian): a narrow footbridge across a stream.

A narrow bridge from ChatGPT & Claude to your desktop. Run [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP) on your own machine and use it from **ChatGPT** and **Claude** remote MCP connectors, over HTTPS and behind an OAuth 2.1 login.

> [!WARNING]
> Desktop Commander has **full filesystem and terminal access** as your user.
> This project makes it reachable from the internet. Read [SECURITY.md](SECURITY.md) before you run it.

## How it works

```
ChatGPT / Claude
      │  HTTPS (e.g. Tailscale Funnel)
      ▼
mcp-auth-proxy.js   :8000   OAuth 2.1 server (DCR + PKCE + refresh) and auth gate for /mcp
      │  http://127.0.0.1
      ▼
http-bridge/bridge.js :8001  Streamable HTTP ⇄ stdio bridge (official MCP SDK)
      │  stdio
      ▼
dc-wrapper.js → @wonderwhy-er/desktop-commander
```

- **`mcp-auth-proxy.js`** is a zero-dependency OAuth 2.1 authorization server (RFC 7591 dynamic client registration, RFC 8414/9728 metadata, authorization code + PKCE S256, rotating refresh tokens). Approving a client requires a **consent PIN** that only you know. Authenticated requests are proxied to the bridge.
- **`http-bridge/bridge.js`** exposes the stdio server as MCP Streamable HTTP. Sessions are keyed by `Mcp-Session-Id` rather than the TCP connection, so clients that open a new connection per request keep working.
- **`dc-wrapper.js`** starts Desktop Commander in its own process group, so the whole process tree is cleaned up on shutdown.

## Requirements

- Node.js 20.6 or newer
- A way to publish `127.0.0.1:8000` over HTTPS. [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) is the easiest; any TLS reverse proxy works.

## Setup

```bash
git clone <this-repo> titian && cd titian
npm run setup                 # installs the bridge's dependencies
cp .env.example .env          # then set MCP_PUBLIC_BASE
```

Start the two services, each in its own terminal (or under launchd/systemd/pm2):

```bash
npm run start:bridge
npm run start:proxy
```

On first start, the proxy generates `.oauth-signing-key` and `.oauth-consent-pin` (mode `0600`) in the repo root, or in `MCP_DATA_DIR` if you set it. Read the PIN with `cat .oauth-consent-pin`.

Publish the proxy, for example:

```bash
tailscale funnel --bg 8000
```

## Connecting clients

Use `${MCP_PUBLIC_BASE}/mcp` as the connector URL.

- **ChatGPT** (custom connector, OAuth): ChatGPT registers itself, then opens the consent page. Enter your PIN and click **Approve**.
- **Claude** (custom connector): same flow. Clients that can't do OAuth can send `Authorization: Bearer <MCP_AUTH_TOKEN>` if you set a static token.

## Configuration

All settings are environment variables. See [`.env.example`](.env.example) for the full list with defaults.

| Variable | Default | Purpose |
|---|---|---|
| `MCP_PUBLIC_BASE` | **required** | Public HTTPS origin, used as the OAuth issuer |
| `MCP_PROXY_PORT` | `8000` | Auth proxy listen port |
| `MCP_BRIDGE_PORT` / `MCP_UPSTREAM_PORT` | `8001` | Bridge port (must match) |
| `MCP_DATA_DIR` | repo root | Where secrets and OAuth state live |
| `MCP_OAUTH_PIN` | auto-generated | Consent PIN |
| `MCP_AUTH_TOKEN` | unset | Optional static bearer token |
| `DESKTOP_COMMANDER_BIN` | `npx -y …` | Use a globally installed Desktop Commander |

## Health checks

`GET /healthz` on both the proxy and the bridge returns `ok`.

## License

[MIT](LICENSE). Desktop Commander is a separate project with its own license.
