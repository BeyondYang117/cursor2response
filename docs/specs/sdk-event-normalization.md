# Cursor SDK Event Normalization

Status: current

## Scope

This spec defines the boundary between raw `@cursor/sdk` run events and the
stable events consumed by the local SDK Bridge. It covers `Run.stream()`
messages, their consistency with `Run.wait()`, native SDK compaction, and
the reasoning boundary between internal events and public protocols.

## Ownership

`bridge/server.mjs` is the only supported raw SDK event
consumer. `normalizeSdkEvent` validates and classifies each complete raw event
before text, tool state, usage, or terminal state can affect the pending run.
Protocol mappers must consume Bridge events instead of reading raw SDK messages.

Normalization is atomic per raw event. If one assistant content block is
unknown or malformed, no preceding text block from that assistant event may be
emitted.

## Canonical events

| Raw SDK message | Canonical classification | Behavior |
| :-- | :-- | :-- |
| `assistant` text block | `text` | Append and stream the validated text. |
| `assistant` `tool_use` block | `diagnostic` | Trace only; `tool_call` owns tool state. |
| `tool_call` | `tool_call` | Validate ID, name, and status before updating the pending batch. |
| `thinking` | `reasoning` | Preserve text and optional duration inside the Bridge event contract; public protocol mappers ignore it. |
| `usage` | `usage` | Accept only complete, finite, non-negative token usage. |
| `status` `CREATING`/`RUNNING` | `progress` | Keep the request alive without changing terminal state. |
| `status` `FINISHED`/`ERROR`/`CANCELLED`/`EXPIRED` | `terminal-impacting` | Retain terminal evidence and reconcile it with `Run.wait()`. |
| `system`/`user`/`request`/`task` | `diagnostic` | Trace without changing the public response. |
| Unknown or malformed semantic shape | `semantic-unknown` | Fail the run explicitly. |

An MCP wrapper call is normalized to its nested client tool name and arguments;
the raw SDK name remains available as metadata. Supported tool statuses are
exactly `running`, `completed`, and `error`.

## Failure contract

The following cases terminate the pending run with Bridge HTTP 502 and internal
code `sdk_semantic_unknown`:

- unknown top-level SDK message type;
- unknown or malformed assistant content block;
- missing tool call ID or name, or an unknown tool status;
- malformed thinking text or duration;
- malformed per-turn usage or malformed `Run.wait()` usage;
- unknown, conflicting, or inconsistent terminal status;
- malformed `Run.wait()` result status.

The Bridge records `sdk_semantic_unknown`, marks the Agent state dirty, evicts
the Agent, rejects parked tool callbacks, and cancels the run when it is already
attached. It must not reuse the Agent or silently continue with partial output.

## Terminal reconciliation

`Run.wait()` remains the source of terminal result details. A terminal stream
status, when present, must map consistently:

| Stream status | Required `Run.wait().status` |
| :-- | :-- |
| `FINISHED` | `finished` |
| `CANCELLED` | `cancelled` |
| `ERROR` or `EXPIRED` | `error` |

Duplicate identical terminal statuses are tolerated. Conflicting terminal
statuses or a mismatch with `Run.wait()` fail closed. When no terminal status
message is emitted, the validated `Run.wait()` result remains authoritative.

## Native compaction observation

`@cursor/sdk@1.0.31` suppresses `summary-started`, `summary`, and
`summary-completed` before its documented per-send `onDelta` callback. The
Bridge registers the synchronous hook in `bridge/cursor-sdk-summary-loader.mjs`
before loading the SDK and removes only that suppression predicate from the
loaded ESM source. The hook requires the exact package name, version, resolved ESM entry, and one
exact source signature match. Any drift prevents Bridge startup; there is no
fallback to the public `task` event.

Summary updates are observations, not terminal errors. Native compaction changes
the SDK's internal conversation checkpoint while the same Run continues. The
Bridge must not cancel, evict, replay, reset transcript hashes, reject parked
tool callbacks, or trigger API fallback merely because a summary update arrives.
This also applies before `Agent.send()` returns and across repeated compactions.
Summary logging, serialization and hashing are best effort; their failures
must not escape the awaited SDK callback or affect execution.

The public transcript remains adapter-authoritative; native summaries do not
replace client history or prove lossless model recall. Subsequent continuations
still require the same ordered transcript prefix and matching public tool IDs.
Actual SDK errors and explicit cancellation retain the normal failure contract.
An explicit legacy `cursor_sdk_context_compacted` error remains supported by
the existing typed error and safe-cleanup fallback path, but summary observation
does not create one.

The [official SDK reference](https://cursor.com/docs/sdk/typescript#interaction-updates)
lists summary updates among normal interaction updates and documents awaited
callbacks. The [release notes for 1.0.31](https://cursor.com/docs/release-notes/sdk#sep-3-2026)
describe background subagent follow-ups and custom-tool annotations, not a
requirement to fail on compaction. The package remains pinned to 1.0.31;
changing versions requires separately validating the loader contract.

## Reasoning boundary

Cursor SDK `thinking` messages remain normalized as internal `reasoning` events.
The private Bridge transport can carry those events for contract tests and
internal consumers, but the supported Sidecar does not request them and public
Responses output contains only assistant message and tool-call items. A
reasoning-only SDK turn therefore remains an empty Responses turn and fails
instead of completing with no usable answer.

Responses requests may continue to include `reasoning.summary`; when present,
`reasoning` must be an object and `summary` must be `auto`, `concise`, `detailed`,
`none`, or null. cursor2response accepts those values for client compatibility but
does not use them to expose Cursor provider traces. `reasoning.effort` continues
to participate in Cursor model selection independently of summary output.

This is a temporary compatibility boundary. cursor2response uses `store: false`, and
stateless multi-turn reasoning requires replaying complete reasoning items with
valid `encrypted_content` according to the
[official OpenAI contract](https://developers.openai.com/api/docs/guides/migrate-to-responses#4-decide-when-to-use-statefulness).
Cursor SDK currently provides no portable reasoning state for cursor2response to
attach, so a synthetic item ID with null encrypted content can break a resumed
thread after a provider switch. Codex does not display the projected trace and
OpenClaw does not consume it, so the projection has no current downstream
consumer to justify that state hazard.

Reconsider public reasoning output only when Cursor SDK exposes a reasoning
contract that is portable across turns and providers, and Codex or OpenClaw
actually consumes or displays it. Restoration must include cross-provider
resume coverage, not only synthetic SSE lifecycle tests.

Historical reasoning input is metadata, not portable Cursor conversation
state. Fresh-Agent prompt reconstruction drops the complete reasoning item.
Missing, null, or empty `encrypted_content` is accepted; any non-empty value is
rejected before SDK execution with HTTP 400 `invalid_encrypted_content`.
cursor2response does not clean or retry that request. A provider-routing layer
owns any one-time removal and retry policy.

## Bridge transport

Bridge NDJSON accepts only `text`, `reasoning`, `error`, and one terminal `done`
event. Unknown or malformed events, a missing `done`, duplicate `done`, or any
event after `done` fail closed. Reasoning deltas carry an explicit segment-end
flag and an optional finite, non-negative duration. `thinkingDurationMs` is
validated transport metadata reserved for internal observability and is not
exposed by public protocol mappers.

## Conformance

Automated tests must cover all nine documented SDK message categories,
assistant multi-block atomicity, every tool status, usage validation, terminal
reconciliation, unknown semantic shapes, loader drift, native compaction before
Run attachment, continued text and tools, unchanged transcript validation,
observation failures, internal reasoning normalization, absence of synthetic public reasoning items,
reasoning-only empty-turn failure, replay filtering, encrypted input, and
Bridge NDJSON terminal rules. Existing pending continuation, tool batching,
superseding turn, cancellation, and empty-turn suites remain required
regression coverage.
