# Workspace permissions

[README](../README.md#permissions-and-owner-approvals) | [Preset reference](#preset-reference) | [Configuration](#configure-from-the-owner-cli) | [Approvals](#owner-approval-flow) | [Blocked commands](#blocked-commands-and-approval-errors) | [Migration](#migration-and-activation) | [Security limits](#limits-this-is-not-a-sandbox)

This guide describes the implemented permission schema version 2, not a Titian product release number. Commands below run in a local owner terminal; use `./bin/titian` from the repository root when `titian` is not on PATH. Replace `example`, `reports`, paths and `REQUEST_ID` with your actual workspace values. Configuration examples are alternatives, not a script to run from top to bottom.

For an existing installation, complete [migration and activation](#migration-and-activation) first. Editing source documentation or policy files alone does not change a running service.

## Model

Titian authorizes operations at the parsed MCP tool-dispatch boundary, before forwarding requests to Desktop Commander. The stdio wrapper is responsible only for transport and child-process cleanup. Permission data is independent of descriptive `capabilities` labels.

Every operation resolves to **allow**, **ask**, or **deny**. Missing rules and unreviewed tools are denied. Invalid policies fail startup; malformed requests fail closed. `ask` without a working local owner endpoint never executes. `deny` is a hard policy decision, not an extra confirmation dialog.

| Preset | Defaults |
|---|---|
| `readonly` | Scoped file reads/searches and output from client-owned process sessions. No arbitrary terminal execution or file mutation. New-workspace default. |
| `editor` | Readonly plus file creation/editing; moving or renaming files asks. Arbitrary execution, URL retrieval and rich rendering remain denied. |
| `custom` | Exactly the provided operation rules; an empty rules object denies everything. |
| `unrestricted` | Allows all mapped operations without routine Titian prompts. Scoped file paths, authentication, protected control paths, process ownership, backend restrictions, and the unreviewed-tool deny rule remain in force. |

Readonly means no requested changes to user files and no arbitrary project execution. Normal runtime bookkeeping, audit logs, and operating-system read metadata may still be written. Readonly does not mean confidential content remains local: tool results are returned to the connected client.

`developer`, `documents`, and `data-analysis` are task templates. Developer and data-analysis choose custom file editing plus per-operation approval for process start/input/stop and document rendering. Documents chooses editor. Templates are explicit grants, not automatic inference from file extensions or repository contents.

## Preset reference

This table expands every operation from [`src/bridge/permissions.json`](../src/bridge/permissions.json). An absent custom rule means `deny`. These are authorization decisions; path checks, protected locations, session ownership and backend validation still apply.

| Operation | `readonly` | `editor` | `custom` | `unrestricted` |
|---|---|---|---|---|
| `files.read` | allow | allow | explicit rule | allow |
| `files.write` | deny | allow | explicit rule | allow |
| `files.move` | deny | ask | explicit rule | allow |
| `search` | allow | allow | explicit rule | allow |
| `process.start` | deny | deny | explicit rule | allow |
| `process.input` | deny | deny | explicit rule | allow |
| `process.read` | allow | allow | explicit rule | allow |
| `process.stop` | deny | deny | explicit rule | allow |
| `system.inspect` | deny | deny | explicit rule | allow |
| `network.fetch` | deny | deny | explicit rule | allow |
| `document.render` | deny | deny | explicit rule | allow |

There is no exception for a supposedly read-only shell command: `start_process` with `pwd` or `git status` is denied in `readonly` and `editor`. Use structured file tools for inspection, or explicitly choose a custom execution rule. Granting `process.read` never grants permission to launch a process.

The `documents` template is exactly `editor`; it does not add rich rendering. The `developer` and `data-analysis` templates allow reads, searches, writes and owned-process output; they ask for moves, process start/input/stop and rich rendering. Only `developer` also asks for `system.inspect`. Both deny `network.fetch` by default; that rule does not restrict networking performed by approved host code.

## Configure from the owner CLI

```sh
titian add "Reports" /absolute/path/to/reports --slug reports
# Above defaults to readonly.
titian update reports --permissions editor

titian update example --template developer
# Custom overrides require custom, including templates that select custom:
titian update example --ask process.start --deny process.input

titian update example --permissions custom --allow files.read --allow search --ask process.start
# No rules means deny all, NOT unrestricted:
titian update example --permissions custom

titian update example --permissions unrestricted
titian permissions example
```

`--allow`, `--ask` and `--deny` accept one operation each and are repeatable. Omitted flags preserve existing custom rules. Choosing a preset or template replaces the policy; conflicting flags for the same operation are rejected. Only custom accepts overrides. Existing clients cannot modify permission settings through MCP.

A policy file can replace the entire policy:

```json
{
  "version": 2,
  "preset": "custom",
  "rules": {
    "files.read": "allow",
    "files.write": "allow",
    "search": "allow",
    "process.start": "ask",
    "process.input": "ask",
    "process.read": "allow",
    "process.stop": "ask"
  }
}
```

```sh
titian update example --policy-file /absolute/path/to/owner-policy.json
```

Policy files are owner input, not repository-discovered grants. The authoritative saved policy is copied into the generated service configuration. Merely editing a file in the workspace does not activate a policy.

## Common workflows

For software work on a trusted project, select the developer template and verify it:

```sh
titian update example --template developer
titian permissions example
```

The assistant can edit scoped files, but each process launch or interactive input requires owner approval. Approving `npm test` authorizes that invocation of project code, not just a harmless command name.

For document work that also needs DOCX/PDF generation without arbitrary terminal execution, explicitly configure rendering:

```sh
titian update reports --permissions custom \
  --allow files.read --allow files.write --allow search \
  --ask files.move --ask document.render
titian permissions reports
```

This replaces the prior policy. Omitted execution and URL-fetch rules deny. Rich rendering requires approval, and the renderer itself is not sandboxed. `files.write` permits creation and overwriting; use `--ask files.write` instead when every write needs review. There is no independent create-only grant in this release.

Append `--dry-run` to an `add` or `update` example to inspect the proposed workspace configuration before applying that change. Preset/template replacement and custom-rule updates have the distinct semantics described above; do not apply a different preset merely to approve one pending request.

## Operations and scope

| Operation | Tools and important conditions |
|---|---|
| `files.read` | Local `read_file`, `read_multiple_files`, `list_directory`, `get_file_info`. Absolute paths inside approved roots only. |
| `files.write` | `write_file`, `edit_block`, `create_directory`, `write_pdf`. Creation and overwriting share this grant in version 2. |
| `files.move` | `move_file`; both source and destination must be in scope. |
| `search` | `start_search`, `get_more_search_results`, `stop_search`; follow-up IDs are bound to the authenticated client. |
| `process.start` | The entire `start_process` invocation, including the shell option and arguments. Arbitrary host execution, not a read-only-command allowlist. |
| `process.input` | `interact_with_process`, separately authorized for a client-owned process session. Approval of the launch does not approve future input. |
| `process.read` | `read_process_output` for a client-owned session only. |
| `process.stop` | `force_terminate` for a client-owned session. Raw `kill_process` is disabled to avoid unscoped or reused-PID signaling. |
| `system.inspect` | Process/session/search listings, configuration, usage and tool history. Can expose information from other clients of the same workspace; an explicit host-inspection grant. |
| `network.fetch` | `read_file` with `isUrl: true`; credential-free HTTP(S). This is not an egress firewall or a domain allowlist. |
| `document.render` | Additional permission for PDF output and DOCX/PDF `write_file`. Rich renderers may process embedded references and are not sandboxed. `files.write` is also required. |

An operation requiring multiple permissions is denied if any denies, asks if any asks, and otherwise runs. There is no separate delete-file tool in the reviewed catalog; arbitrary deletion via an authorized host program is part of granting host execution, not independently preventable by this filter.

All explicit filesystem paths are canonicalized and checked against roots and protected control directories. Out-of-root symlinks, dangling symlinks, multiply hard-linked files and special files are rejected. Recursive operations on an ancestor containing Titian state are rejected; narrow the path to a source/output subdirectory instead. Backend resources/prompts are unavailable in restricted presets except Titian's own metadata resource, because their access paths have not been mapped to scoped operations.

## Owner approval flow

1. A client calls an operation whose decision is `ask`. Titian stores its exact normalized request and returns `approval_required`. Nothing reaches Desktop Commander.
2. The owner reviews the request on the Mac:

   ```sh
   titian approvals example list
   titian approvals example show REQUEST_ID
   titian approvals example approve REQUEST_ID
   # Or: titian approvals example reject REQUEST_ID
   ```

3. The CLI prints the exact tool, arguments, scope, client identity and host-execution context. The owner must type `approve REQUEST_ID` in an interactive terminal. There is no `--yes`, MCP approval tool, or `approved: true` parameter.
4. Approval changes only the stored request status. The client explicitly calls `titian_resume` with `{ "requestId": "..." }` to execute the approved request once.

Approvals expire five minutes after the original request. They are tied to the authenticated OAuth client (or the shared static-token identity), project, policy revision, arguments, canonical paths and file metadata, runtime environment/configuration fingerprint, and process-session generation. A changed target or context invalidates approval. Interactive-input previews include the original process invocation.

Consumption happens before dispatch, including when Desktop Commander rejects the request or an execution error occurs. Concurrent resume attempts cannot execute it twice. A lost result must not be blindly replayed; inspect the outcome and create a new request only when appropriate. Rejected, expired, consumed or wrong-client requests never execute. Repeating the original call does not consume an approval; use explicit resume.

The queue is bounded to 200 records. It and session ownership are in memory, so bridge restart, permission update or disable drops them. Outstanding approval IDs are not reusable after restart. The local socket is mode 0600 in an account-owned 0700 instance directory. The CLI is the only owner interface supplied in this release; there is no browser approval UI or MCP elicitation integration.

A Titian approval never edits Desktop Commander's `blockedCommands` or weakens its validation. Backend rejection is returned unchanged. Permanent permission changes remain separate owner operations.

## Blocked commands and approval errors

**A blocked command does not automatically become an approval request.** Only an effective `ask` rule creates one. If `process.start` is `deny`, the owner must deliberately select a different policy or custom rule through the CLI. That update restarts the workspace and discards pending requests. Do not switch the workspace to `unrestricted` just to approve one action.

| Result | What to do |
|---|---|
| `denied` | Inspect the reason and `titian permissions example`. A policy denial requires an owner change; an out-of-scope path or unowned session requires a valid request. No approve-once request exists. |
| `approval_required` | Nothing executed. Review the returned `requestId` locally, approve or reject it, then use `titian_resume` from the same authenticated client after approval. |
| `approval_unavailable` | Nothing executed. Check the bridge and local owner endpoint; restore them before submitting another request. There is no automatic allow fallback. |
| `approval_queue_full` | Nothing executed. Stop repeated submissions; expired records are removed when the queue is listed or another request is evaluated. Rejection does not immediately remove a record. |
| `approval_rejected` | Read the message: the request may be missing, expired, unapproved, consumed, owned by another client or invalidated by a change. Executor errors can also produce this status after consumption; inspect effects before requesting another attempt. |
| Backend `Command not allowed` | Desktop Commander rejected the invocation under its own validation. Titian approval does not remove `blockedCommands`; the consumed approval is not restored. |

**Can the assistant ask to enable a command?** It can explain an `approval_required` result and direct the owner to the local review command. It cannot approve by saying the user agreed, sending an `approved` flag, or calling a permission-mutation MCP tool. There is no automatic browser or chat confirmation dialog in this release. Persistent grants are separate local policy changes, not a side effect of approve-once.

Approving a shell launch does not grant future interactive input: each `interact_with_process` request is checked under `process.input` and tied to the client-owned session. Approval trusts the entire submitted command; it does not constrain what an approved script may do with host privileges. See [security limits](#limits-this-is-not-a-sandbox).

For service-level failures, see [permission and approval troubleshooting](troubleshooting.md#permission-denied-or-approval-required).

## Effective policy and audit

`titian permissions example` displays both the configured policy and the effective policy read from the running bridge. Status is active only when policy, expanded rules and roots match. Missing/old/offline runtime responses are unverified. `titian_permissions` is a read-only MCP tool for the same runtime policy.

Add, update and runtime activation verify restarted services before reporting success. Failures restore previous state through the existing lifecycle rollback path. Stopped services remain unverified until started. Editing source without building/activating runtime changes no live permissions.

Permission decisions are logged with event, request ID, operation, request hash and hashed client identity where applicable, not full arguments or file contents. These are ordinary service logs, not tamper-proof audit storage. Desktop Commander's separate tool history may contain arguments and outputs and must be treated as sensitive.

## Migration and activation

Inspect/build without activating:

```sh
titian runtime check
```

Activation restarts active project services and interrupts in-flight operations:

```sh
titian runtime update --legacy-permissions readonly
# Choose broader access explicitly for a specific workspace afterwards:
titian update example --template developer
titian permissions example
```

`--legacy-permissions` accepts readonly, editor or unrestricted and applies only to registry entries with no version-2 policy. Without it, activation refuses before stopping services when legacy entries exist. Existing policy fields are validated and preserved. Credentials and URLs are retained; launch-agent environments are regenerated alongside the runtime, with rollback on activation failure.

Old `--command-mode`, `--allowed-commands`, `commandMode`, and `allowedCommands` do not define version-2 permissions. Prefix lists are not converted silently: owner choice is required. New add/update refuses to claim enforcement with an installed runtime lacking the version-2 build marker.

## Limits: this is not a sandbox

Approving arbitrary host execution authorizes the submitted program/script with the OS account's privileges. Project code, shell startup files, helpers and dependencies can do more than the command name suggests. Approval binds an invocation, not an immutable snapshot of every file that program might execute. Titian cannot infer effects from a command prefix.

The local management channel is protected from remote MCP approval calls and ordinary scoped file access. It is NOT protected from hostile code already running as the same OS account: that code may access the owner socket, credentials, state or configuration. TTY confirmation is protection against accidental/noninteractive approval, not an OS identity boundary. Use a separately isolated account/VM or other reviewed containment for untrusted code; version 2 does not implement that isolation or silently fall back to it.

Filesystem canonicalization is defense in depth, not a kernel sandbox. Concurrent filesystem changes and complex document parsers are not fully contained. Network, credentials and file effects of approved programs are not limited by the structured-file roots. `unrestricted` does not bypass OS or backend restrictions, and no preset is suitable for mutually untrusted users sharing an OS account.
