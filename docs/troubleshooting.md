# Troubleshooting

Titian's MCP bridge uses stateless Streamable HTTP. Each POST is handled by a
fresh MCP server/transport and forwarded to the long-lived Desktop Commander
process for that project. The bridge does not retain an `Mcp-Session-Id` map.

## Client reports connection failed or UNAVAILABLE

Start with the service path instead of assuming a session or timeout problem:

```sh
titian status
titian doctor
tail -20 .titian/logs/com.titian.<slug>.auth.err.log
tail -20 .titian/logs/com.titian.<slug>.bridge.err.log
```

A healthy request reaches the bridge as a line similar to:

```text
POST stateless bodyLen=863 method=tools/call suppliedSession=false
```

`suppliedSession=true` is also valid. A stale session header from an older
client connection is ignored because Titian does not use HTTP session state.

## `doctor --public` fails on one public IP

`titian doctor --public` resolves the configured HTTPS hostname through public
DNS, then probes each advertised A record with `curl --resolve`. Local checks
can pass while one public IP fails:

```text
example: auth=OK, bridge=OK, oauth-routing=OK, mcp=OK, public-203.0.113.10=OK, public-203.0.113.11(curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL ...)=FAIL
```

In this case, Titian's local auth, gateway and bridge are healthy. The failure
is on the public HTTPS path for that one address. With Tailscale Funnel, this
usually means DNS is advertising a stale or unhealthy Funnel edge. Clients may
fail intermittently depending on which address they receive.

Verify the local Funnel mapping:

```sh
tailscale funnel status
```

For a Titian gateway, the Funnel target should point to `http://127.0.0.1:8300`.
If the mapping is correct but one public IP still fails TLS, refresh Funnel:

```sh
tailscale funnel reset
tailscale funnel --bg http://127.0.0.1:8300
titian doctor --public
```

If the same public IP continues to fail after a refresh, wait briefly and retry,
or check Tailscale status for an edge outage. A persistent single-IP TLS failure
is outside the Titian project services.

## Why the bridge is stateless

The previous bridge issued session IDs and stored transports in memory:

```js
const sessions = new Map();
```

Real logs showed `tools/call` requests arriving without a session header:

```text
POST REJECT: sessionId=undefined inMap=false method=tools/call
```

The request was rejected before Desktop Commander could execute the tool.
Restarts could also invalidate every session stored in that process.

Titian does not need that state. Tool calls, resources and prompts are proxied
to one long-lived Desktop Commander process per project, so HTTP requests can
be independent. The bridge now creates:

```js
new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
```

No session ID is issued during initialization and no session ID is required on
later POST requests.

## GET and DELETE return 405

This is intentional. Stateless Streamable HTTP has no session-specific GET SSE
stream to resume and no session to terminate with DELETE. Compatible clients
treat HTTP 405 on the optional GET stream as "stream not supported" and continue
using POST requests.

## Permission denied or approval required

Check permissions separately from connection health:

```sh
titian status example
titian doctor example
titian permissions example
titian approvals example list
```

`activation: active` means the running policy matches the configured policy. `unverified` means there is no verified response from a compatible runtime; `mismatch` means the reported policy does not match. A healthy listener or a policy saved in the registry is not proof of enforcement. See [migration and activation](permissions.md#migration-and-activation) for installing the permission runtime.

For `approval_required`, review the returned request ID with `titian approvals example show REQUEST_ID`, then approve or reject it in an interactive local terminal. The same authenticated client must call `titian_resume` after approval; sending the original command again is not a resume. There is no browser approval dialog in this release.

For `denied`, inspect the reason. A hard policy denial has no approve-once shortcut; only an owner policy change can authorize it. Path and process-ownership failures need a valid scoped request, not a broader command allowlist. `readonly` and `editor` deliberately reject all shell launches, even `pwd` and `git status`.

Approvals expire five minutes after the original request and disappear when the bridge restarts. Requests can also be rejected after a target or execution context changes. Do not blindly resubmit an operation when a result is lost; it may already have executed. Inspect its effects first.

If the CLI requires an interactive terminal, use the owner's local terminal rather than piping confirmation or asking the assistant to approve itself. If Desktop Commander returns `Command not allowed`, Titian approval does not change that backend restriction.

See [blocked-command results](permissions.md#blocked-commands-and-approval-errors) for the complete status reference, including an unavailable owner endpoint and a full approval queue.

## Restarts

A bridge restart no longer leaves a client holding a server-side session that
does not exist. Requests sent after the process returns are independent.

An in-flight request is still interrupted if its process is restarted. Its
side effects may already have occurred, so inspect the result before retrying a
write or execution request. Restart clears pending approvals and process-session
ownership; create and review a new request when another attempt is appropriate.

After source changes:

```sh
titian runtime check
titian runtime update
titian status
```

`runtime check` validates a temporary runtime first. `runtime update` replaces
the runtime and restarts active services while retaining the previous runtime
for rollback.

## Long-running tool calls

Do not diagnose a five-minute tool failure from Node's `requestTimeout`.
That setting limits how long Node waits to receive an HTTP request; it is not a
five-minute ceiling on how long a completed request body may wait for a tool
response.

Titian does not add an application-level five-minute response timeout in the
bridge. If a tool consistently fails after a fixed duration, inspect the client,
HTTPS proxy and network path and correlate their timestamps with Titian logs.

For long local work, prefer the Desktop Commander process pattern:

```text
start_process -> periodic read_process_output -> final result
```

This keeps command execution observable and avoids tying progress reporting to
one silent request.

## Related

- [operations.md](operations.md) for service lifecycle and runtime updates
- [architecture.md](architecture.md) for gateway, OAuth proxy and bridge layout

## Backend recovery

The bridge exits with status 1 if its Desktop Commander stdio connection closes unexpectedly. The launchd KeepAlive policy restarts it. An in-flight tool call can fail during recovery and should be retried.

`/healthz` now sends an MCP ping to Desktop Commander rather than only testing the HTTP listener. It returns 503 when the backend does not respond within five seconds, then exits for supervisor recovery. A background ping every 30 seconds also detects an unresponsive backend when no health check is running. Concurrent health requests share a single probe.

`titian doctor` allows seven seconds for the health response. Authentication health and bridge/backend health remain separate checks. A healthy HTTP listener or cached tool catalog alone is not sufficient evidence that commands can execute.
