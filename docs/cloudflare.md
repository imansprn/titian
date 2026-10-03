# Cloudflare networking

## Purpose

**Status: implemented, first cut.** Titian can select Cloudflare, run an existing remotely managed Tunnel through a local launchd agent, and diagnose local and public connectivity. DNS records and the Tunnel's public-hostname route remain externally managed. No live Cloudflare account or Tunnel was changed while implementing this support.

Cloudflare Tunnel provides HTTP MCP access. Cloudflare DNS provides the hostname; the Tunnel provides connectivity. This complements existing external publication options, does not replace Tailscale DNS, and does not implement Cloudflare Mesh.

## Goals

- Keep existing Tailscale behavior unchanged.
- Allow Cloudflare as an explicit provider.
- Keep the public hostname stable across Titian restarts.
- Avoid inbound port forwarding.
- Keep the Titian gateway bound to `127.0.0.1`.
- Preserve OAuth, project authentication, permissions, routing, and approval behavior.
- Keep provider credentials out of source, metadata, and normal logs.
- Allow switching providers without changing project credentials or MCP routes.

## Request path

    Client
      |
      | https://titian.example.com
      v
    Cloudflare DNS / Edge
      |
    Cloudflare Tunnel
      |
    cloudflared
      |
      | http://127.0.0.1:8300
      v
    Titian Gateway
      |
      +--> /projects/<slug>/mcp

The Tunnel creates outbound connections from `cloudflared` to Cloudflare. Titian does not need a public origin IP or inbound port.

**Important:** DNS alone does not expose the local gateway. The Tunnel and `cloudflared` path must reach the local gateway for the provider to work.

## Provider model

Public endpoint details must live behind a provider-neutral interface:

    NetworkProvider
    ├── tailscale
    └── cloudflare

The provider configuration should contain, at minimum:

    provider
    hostname
    tunnelId
    origin
    credentialRef
    cloudflaredBinary
    cloudflaredVersion
    metricsPort

Conceptual Cloudflare configuration:

    {
      "network": {
        "provider": "cloudflare",
        "hostname": "titian.example.com",
        "tunnelId": "<tunnel-id>",
        "origin": "http://127.0.0.1:8300",
        "credentialRef": "<local-secret-reference>",
        "cloudflaredBinary": "<absolute-path>",
        "cloudflaredVersion": "2026.9.1",
        "metricsPort": 43171
      }
    }

The credential reference points to a locally protected secret. The credential value itself must never be stored in this configuration object, project metadata, Git, or normal logs.

Existing Tailscale configuration remains available. Selecting Tailscale records the external hostname; Titian does not manage Tailscale Funnel's lifecycle.

## CLI

The network provider must be observable and configurable without exposing secrets.

Available commands:

    titian network status
    titian network configure tailscale [--hostname HOSTNAME]
    titian network configure cloudflare --hostname HOSTNAME --tunnel-id UUID --token-file PATH [--cloudflared PATH]
    titian network doctor

Behavior:

- `network status` reports the selected provider, hostname, Tunnel ID, local process, and readiness without printing credentials.
- `network configure tailscale` records the configured hostname. Funnel remains externally managed.
- `network configure cloudflare` validates the hostname, Tunnel UUID, token file, and `cloudflared` version before activation. It copies the token into the selected Titian state directory with owner-only permissions.
- Cloudflare configuration installs or updates a launchd agent for `cloudflared`, disables its self-updater, and waits for the local `/ready` endpoint.
- `network doctor` checks local provider health and then runs project local-health, public DNS, and HTTPS checks. It does not change DNS, Tunnel routes, or other Cloudflare resources.
- Provider changes preserve local OAuth credentials and project route paths. Changing the hostname changes project URLs and OAuth issuer metadata, so MCP clients must be pointed at the new URLs and reconnected.

Cloudflare configuration fails before activation when required fields, the executable, its supported version, or the token file is missing or invalid. A healthy tunnel process does not prove that the public DNS record or Tunnel route is correct; use `network doctor` to check the public endpoint.

## Cloudflare prerequisites

A persistent Cloudflare deployment requires:

1. A Cloudflare account and a domain managed by Cloudflare.
2. An existing remotely managed Cloudflare Tunnel.
3. `cloudflared` 2025.4.0 or later on the Titian host ([`--token-file` requires this version](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file)).
4. A public-hostname route for the Tunnel that targets `http://127.0.0.1:8300`.
5. A DNS record for that hostname and the Tunnel's run token in a local file.

Example route:

    Hostname: titian.example.com
    Service:  http://127.0.0.1:8300

The route must terminate at the **Titian gateway only**. It must never point directly at project processes or project-specific ports.

Cloudflare maps the hostname to the Tunnel; the Tunnel then forwards to the loopback origin.

## `cloudflared` lifecycle

Titian does not silently install or upgrade `cloudflared`. `network configure cloudflare` requires an existing executable, checks for version 2025.4.0 or later, and registers the Tunnel process as a launchd agent. The agent uses `--no-autoupdate`; install and upgrade `cloudflared` as an explicit user operation. Titian starts and stops only its own Tunnel process and leaves user-owned Cloudflare resources unchanged.

## Stable-hostname behavior

DNS configuration, Tunnel identity, and the local MCP origin are separate resources.

    Titian restart
        -> DNS unchanged
        -> hostname unchanged
        -> tunnel ID unchanged

    Titian stopped
        -> DNS unchanged
        -> hostname unchanged
        -> requests fail because the origin is unavailable

    Host public IP changes
        -> no DNS update required
        -> cloudflared reconnects outbound

Titian must never recreate DNS records or a Tunnel merely because the gateway restarts.

## Lifecycle

### Start

1. Validate provider configuration.
2. Start the Titian gateway on loopback.
3. Start or verify `cloudflared`.
4. Verify Tunnel connectivity.
5. Verify the configured hostname reaches the Titian gateway.
6. Run an authenticated MCP health check.

### Restart

Restarting Titian must preserve the provider, hostname, Tunnel ID, and project credentials.

### Stop

Stopping Titian stops the local origin. It must not delete Cloudflare DNS records or Tunnel resources.

### Disable

Disabling Cloudflare removes it from active Titian routing. It must not automatically delete user-owned Cloudflare resources.

## Health model

Titian should distinguish these states:

    provider configured
    cloudflared available
    provider process running
    tunnel connected
    local origin reachable
    public hostname reachable
    MCP authentication working

Example:

    Provider configured   OK
    cloudflared           OK
    Cloudflare Tunnel     OK
    Titian Gateway        DOWN
    MCP                   DOWN

A stopped gateway is an origin failure, not a DNS failure.

## Failure behavior

| Failure | Expected result |
|---|---|
| Missing cloudflared | Cloudflare activation fails with a prerequisite error |
| Invalid provider config | Activation fails before routing changes |
| Titian gateway down | DNS and Tunnel remain configured; origin requests fail |
| cloudflared down | DNS remains configured; public requests fail |
| Tunnel disconnected | DNS remains configured; public requests fail |
| Public IP changes | No DNS update required |
| OAuth failure | Request remains unauthorized |
| Invalid Cloudflare credentials | Provider becomes unhealthy; no automatic credential rotation |
| Provider switch | Project credentials and MCP routes remain unchanged |

Do not silently fall back from Cloudflare to Tailscale.

## Security

- Keep the gateway loopback-only.
- Treat Cloudflare credentials as secrets.
- Keep Cloudflare and OAuth credentials separate.
- Never expose Tunnel credentials through `titian_project_info`.
- Never print credentials from `titian doctor`.
- Redact credentials from logs and diagnostics.
- Do not expose manager/owner endpoints through the public MCP route.
- Preserve existing permission and approval boundaries.
- Do not route the public hostname directly to project processes.

Cloudflare Tunnel provides transport/publication; it does not replace Titian's MCP authentication.

Titian must continue enforcing:

- OAuth;
- project authentication;
- project routing;
- permissions;
- approval gates.

Cloudflare Access service tokens are a possible later hardening layer, not a V1 requirement.

## Migration

Provider migration preserves project route paths, local OAuth credentials, permissions, and approvals. If the hostname changes, Titian updates project URLs and issuer metadata. Update the MCP client URL and reconnect so it discovers the new issuer.

### Tailscale -> Cloudflare

1. Create/configure the Cloudflare Tunnel and hostname.
2. Run `titian network configure cloudflare --hostname HOSTNAME --tunnel-id UUID --token-file PATH`.
3. Run `titian network doctor` and verify authenticated MCP access through the Cloudflare hostname.
4. Update client URLs and reconnect where the hostname changed.
5. Confirm local OAuth credentials, route paths, permissions, and approvals remain unchanged.
6. Stop using Tailscale only if it is no longer needed; Titian does not stop or delete its external resources.

### Cloudflare -> Tailscale

Use the inverse sequence:

1. Configure and validate the Tailscale hostname with `titian network configure tailscale --hostname HOSTNAME` and `titian network doctor`.
2. Update client URLs and reconnect where the hostname changed.
3. Confirm local OAuth credentials and route paths are unchanged.
4. Cloudflare's local `cloudflared` agent is stopped when Tailscale is selected. DNS records and Tunnel resources are left intact.

Titian must not delete the previous provider's user-owned resources during migration.

## Testing

### Unit

- provider selection;
- configuration validation;
- provider field persistence;
- credential-reference redaction;
- stable hostname handling;
- failure-state classification;
- provider switching without project credential changes.

### Integration

- valid Cloudflare configuration starts;
- missing `cloudflared` fails before activation;
- invalid configuration fails before activation;
- gateway remains loopback-only;
- Titian restart keeps hostname and Tunnel ID;
- MCP stop does not mutate DNS configuration;
- Tunnel failure is distinguished from origin failure;
- public routing reaches only the gateway;
- Tailscale behavior remains unchanged.

Do not modify live Cloudflare resources from automated tests unless explicitly requested.

## Setup and validation

1. Create a remotely managed Tunnel and configure its public-hostname route in Cloudflare to `http://127.0.0.1:8300`.
2. Create the hostname's DNS record and save the Tunnel run token in a local file readable by your account.
3. Configure Titian with `titian network configure cloudflare --hostname HOSTNAME --tunnel-id UUID --token-file PATH`.
4. Run `titian network status`, then `titian network doctor`.
5. Update MCP client URLs and reconnect after a hostname change.

The route and DNS setup remain outside Titian. `network doctor` makes public unauthenticated requests and expects the project auth service to return HTTP `401`. Review the individual checks: a DNS failure may repeat for every project that shares a hostname, while a failed `public-<ip>` check indicates that the HTTPS route did not return the expected response.

## Cloudflare Mesh

Cloudflare Mesh/private networking is intentionally out of scope for the first Cloudflare integration.

The provider abstraction must remain extensible so Mesh can be added later without changing project routing.

For Titian's current single HTTP MCP gateway, Cloudflare Tunnel maps a public hostname to the local service.

## Implementation status

The first-cut implementation covers local provider configuration and process health. Public routing still depends on the user-created DNS record and Tunnel route; Titian cannot inspect or enforce their Cloudflare dashboard settings. The checklist below separates implemented behavior from that external prerequisite.

- [x] Tailscale remains externally managed and selectable.
- [x] Cloudflare can be selected using an existing remotely managed Tunnel.
- [x] Provider configuration records hostname, Tunnel ID, origin, and a local credential reference.
- [x] `titian network status` reports provider health without printing credentials.
- [x] `titian network doctor` checks provider and public endpoint health without mutating Cloudflare resources.
- [x] Titian preserves the hostname across restarts.
- [x] Titian leaves DNS and Tunnel resources intact when Cloudflare is deselected.
- [x] No inbound port is required by the Tunnel.
- [x] The Titian gateway remains loopback-only.
- [x] The Tunnel token is copied to a protected local file and is not stored in manager metadata or logs.
- [x] OAuth and permissions remain enforced by Titian.
- [ ] The externally configured public route points only to the Titian gateway (verify in Cloudflare configuration).
- [x] Provider migration preserves local credentials and project route paths; hostname changes require client reconnects.
- [x] Titian does not automatically fall back between providers.
