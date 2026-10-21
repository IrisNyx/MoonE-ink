# Protocol compatibility notes (MCP-01 through publication v2)

Date: 2026-10-05 (MCP-03b additions below). Everything above and below describes what
the *installed official SDK actually does* — the service never invents a version or
fakes compatibility.

## The actual negotiation matrix

The service is built on the official MCP TypeScript SDK **v2**, which ships as
split packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`,
`@modelcontextprotocol/core`, plus the `@modelcontextprotocol/node` adapter for
plain `node:http`). All versions are exact-pinned in `package-lock.json`:

| Package | Version | Role |
| --- | --- | --- |
| `@modelcontextprotocol/server` | 2.3.1 | server SDK: `createMcpHandler`, `McpServer` |
| `@modelcontextprotocol/node` | 2.1.1 | `toNodeHandler` adapter onto `node:http` |
| `@modelcontextprotocol/client` | 2.3.1 | test-side official clients |
| `@modelcontextprotocol/core` | 2.3.1 | shared core (transitive, pinned by the above) |

The served protocol matrix — exactly the three revisions the engineering spec
requires, each proven by a pinned official client in `test/protocols.test.ts`:

| Revision | Era | Served by |
| --- | --- | --- |
| `2026-07-28` | modern | SDK v2 modern leg: per-request `_meta` envelope, `server/discover` negotiation, version selection |
| `2025-11-25` | legacy | SDK stateless legacy fallback: `initialize` → `initialized` → calls |
| `2025-03-26` | legacy | same legacy leg (gateway-era compatibility baseline) |

`ephemera_service_info` reports this matrix live
(`protocol.supported_versions = ["2026-07-28","2025-11-25","2025-03-26"]`,
`latest_version = "2026-07-28"`) together with the SDK package identity, so the
advertised contract cannot drift from the binary.

## How `/mcp` is composed (official mechanisms only)

One `createMcpHandler(factory, { legacy: 'stateless', ... })` mounted through
`toNodeHandler` onto the service's `node:http` server:

1. **Modern leg (2026-07-28).** Requests carrying the per-request `_meta`
   envelope claim are routed by the SDK's own classification to its modern
   path: `server/discover` advertises `supportedVersions: ["2026-07-28"]`,
   version selection follows the 2026-07-28 negotiation (including the
   `-32022` corrective continuation), and every exchange runs with the
   per-request envelope. The official client proves this row with
   `versionNegotiation: { mode: { pin: '2026-07-28' } }` — pin mode has **no
   fallback**, so the test fails at connect if the server cannot do the
   modern era (it can never pass by silently running a 2025 handshake).
2. **Legacy leg (stateless, 2025-11-25 / 2025-03-26).** Claim-less POSTs
   (including `initialize` and 2025-era notifications) go to the SDK's
   built-in stateless legacy fallback: each request is answered by a fresh
   instance from the same factory over a session-less streamable HTTP
   transport. A legacy `initialize` for a served revision is echoed verbatim;
   any other requested revision is answered with the server's newest legacy
   revision (official counter-offer semantics — a standard client then aborts
   rather than continuing under a version it did not request; pinned by
   `F05: unknown protocol revision is not silently served`).
3. **Session operations.** Because this deployment is session-less, GET and
   DELETE on `/mcp` (2025 session operations) are answered `405 Method not
   allowed` by the SDK fallback itself. No session state exists anywhere;
   instance identity lives in SQLite, not in MCP sessions.

Body-less GET/DELETE, batches, posted responses, and empty/invalid-JSON POSTs
are classified legacy by the SDK (its documented routing), so their handling is
the SDK's per-version behavior, never a silent re-interpretation. A POST whose
`MCP-Protocol-Version` header names a modern revision but lacks the envelope is
rejected by the SDK's validation ladder (`-32602`), not executed as another
revision.

## Version/error behavior a standard client sees

- `initialize` at `2025-11-25` / `2025-03-26` → echoed, lifecycle proceeds.
- `initialize` at an unserved revision → counter-offer naming a served legacy
  revision; official clients refuse the mismatch (typed error).
- Envelope claiming an unserved modern revision → `UnsupportedProtocolVersion`
  naming the supported set (SDK modern-leg behavior).
- Unknown tool → typed `-32602` "Tool … not found" error (the v2 client throws
  `ProtocolError`; there is no fake-success result).
- Invalid tool arguments → `isError` tool result with recognizable
  invalid-params text; strict schemas reject unknown top-level fields.
- Unparseable body → `-32700` parse error.
- Authentication/host/origin failures are HTTP-level (401/403) and cover
  discovery, initialize, calls, and GET/DELETE alike.

## Test wiring (F02 evidence)

`test/protocols.test.ts` runs the full lifecycle — discovery/negotiation where
the era has it, `tools/list`, `ephemera_service_info`, `ephemera_list_genres` —
for each of the three rows with a **stock official client**:

- modern row: `connectModernClient` pins `2026-07-28` (no fallback), then
  asserts `era() === 'modern'`, `negotiatedVersion() === '2026-07-28'` and a
  discover result offering the revision;
- `2025-11-25` and `2025-03-26` rows: `connectLegacyClient` pins
  `supportedProtocolVersions: [<revision>]` (plain 2025 handshake), then
  asserts `era() === 'legacy'` and the echoed revision;
- a cross-row test asserts the three connections are wire-distinct
  (`modern@2026-07-28` vs `legacy@2025-11-25` vs `legacy@2025-03-26`), so the
  rows can never collapse into "one request replayed three times".

No transport subclassing, no request rewriting, no hand-written JSON-RPC
client anywhere in the suite. Raw HTTP probes are used only for negative paths
(auth, host/origin, malformed input, session-less semantics) where full header
control is the point.

## Security-relevant HTTP behavior

- `Host` allowlist (port-insensitive) and `Origin` policy run before
  authentication and before any protocol handling.
- Bearer authentication (SHA-256 digests, timing-safe compare) covers every
  `/mcp` exchange; the validated identity is passed to the SDK factory as
  pass-through `authInfo` (the raw token is never retained).
- `401` carries `WWW-Authenticate: Bearer`; revoked credentials get `403`.
- `GET /healthz` is anonymous and returns process liveness only.
- Errors and logs never contain tokens or credential digests; tool errors use
  the `{ok:false, error:{code,message,retryable}}` shape or SDK protocol
  errors. Startup/test diagnostics redact operator-private paths.

## Acceptance mapping (F01–F09)

| Row | Where it is proven |
| --- | --- |
| F01 | `scripts/verify.mjs` phases (offline install → build → real process) + smoke; `test/instance.test.ts` |
| F02 | `test/protocols.test.ts` (three pinned official-client rows: modern discover/negotiation + two legacy initialize lifecycles, each with `tools/list` and both tool calls), `test/stateless.test.ts` |
| F03 | `test/auth.test.ts` (401/403/origin/host/healthz; auth covers discovery and calls) |
| F04 | `test/instance.test.ts` (identity persistence, fresh dir, duplicate owner, crash recovery) |
| F05 | `test/protocols.test.ts` (unknown tool, bad args, unknown version counter-offer refused by stock client, header-without-envelope ladder, parse error) |
| F06 | `test/protocols.test.ts` (`assertReadOnlyContract`: exactly the four MCP-03b tools with accurate read-only flags, publish-aware capability set, postcard supported + four planned-but-unsupported genres) |
| F07 | `test/config.test.ts` (non-zero exits enforced by `expectFailedStart`), `test/instance.test.ts` (port closed, clean stop), verifier timeouts + spawned-process cleanup |
| F08 | `test/auth.test.ts` (token never in output), `config.example.json` placeholders only, redacted harness diagnostics, renderer CLI/tests leak neither body content nor absolute paths |
| F09 | `scripts/verify.mjs` (hash-verified copy, offline install, split-package presence check, source-unchanged check, non-empty test requirement) |

## MCP-02 additions (renderer, no protocol surface change)

The MCP surface is unchanged: still exactly `ephemera_service_info` and
`ephemera_list_genres`, both read-only. What changed is the *content* of the
discovery answers:

- `capabilities.renderer = true` (publish/history/device_channel remain
  `false`); `rendered_profiles = ["epaper-540x960-gray4-v1"]`.
- `service_version = "0.2.0"`.
- `ephemera_list_genres({})` now returns exactly the `postcard` genre with
  `supported: true` and `accepted_fields: ["intent","body","tone"]` (the
  postcard paper has no title/subtitle slot; the offline renderer rejects a
  non-empty title/subtitle with `unsupported_content_slot`); the planning
  view (`only_supported: false`) still lists all five genres with accurate
  support flags.
- The renderer itself is an **offline CLI** (`dist/src/render/cli.js`), not an
  MCP tool — wiring it into the publication loop is MCP-03.

## MCP-03a additions (persistent acceptance domain, no protocol surface change)

(Historical record of that batch; the current service is described by the
MCP-04 section at the end.)

The MCP surface is unchanged again: still exactly `ephemera_service_info` and
`ephemera_list_genres`, both read-only, and the capability set is untouched
(publish/history/device_channel remain `false`; `renderer` stays `true`).
What MCP-03a adds lives entirely below the protocol layer:

- The SQLite schema moves to version `2` (in-place migration from accepted
  v1 data directories; `instance_id` and `instance.created_at` preserved).
  `ephemera_service_info` continues to report `api_schema_version: 1` — the
  business API and the database schema version are separate identities.
- `service_version = "0.3.0"`.
- The acceptance domain (`src/domain/`, `src/storage/`) implements manuscript
  validation, canonicalization v1 + SHA-256 request digests, the
  `(instance_id, caller_id, request_id)` idempotency ledger, operations with
  global acceptance sequence and per-local-date `YYYY-MM-DD-NN` reservations,
  queue capacity and caller-scoped lookup. It is a code-level interface
  exercised by the test suite only; no `ephemera_publish` or
  `ephemera_request_status` tool exists in this batch. MCP-03b wires the
  public tool on top of this domain (and must first define the missing
  `titleAdaptation` wire schema the domain deliberately rejects).

## MCP-03b additions (publication loop: the tool surface grows to four)

MCP-03b is the first batch that changes the tool surface. `tools/list` now
returns exactly four tools; all of them are discoverable and callable on every
served revision above:

- **`ephemera_publish`** (`{ expected_instance_id, request_id, manuscript }`,
  strict): submits the manuscript through the persistent acceptance transaction
  for the **authenticated caller** and returns the stored receipt immediately
  (`accepted: true` means durable and queryable, never rendered). The handler
  never waits for the worker or Chromium — P05 proves this with a blocked
  renderer. Same key + input replays the same operation (same operation id and
  reserved number) with the current status; a different input for the same key
  is `idempotency_conflict`. The tool accepts no `caller_id`, credential id,
  template path, HTML/CSS/JS, Paper, file path, URL, renderer parameters or
  hardware commands — caller identity travels only in the request-local context
  derived from the bearer credential.
- **`ephemera_request_status`**
  (`{ expected_instance_id, operation_id? | request_id? }`, exactly one lookup
  key): caller-scoped read of the acceptance facts plus
  `accepted|processing|published|failed`. `published` adds a read-only
  publication summary (publication id, commit sequence, edition, target
  profile, renderer/Chromium/Playwright/font versions, ordered pages with PNG
  and gray4 SHA-256 digests and byte lengths — never an absolute path).
  `failed` adds a stable failure code with `retryable: false` — never a raw
  Chromium/SQLite/OS message, SQL, manuscript text or temp path. Another
  caller's operation and an unknown id return the same fixed `not_found`.
  The four statuses are always bounded: attempts are capped at three, and an
  operation whose every attempt crashed (process killed mid-lease) is
  terminalized durably by the next worker claim after the final lease
  expires — atomically `failed` with `render_failed`, attempt count 3, a
  cleared lease and a durable `completed_at` — so `processing` can never
  become a permanent state and no fourth renderer invocation exists; the
  acceptance facts (operation id, caller, manuscript BLOB/digest, request
  ledger, acceptance sequence, reserved publication id, replay behavior)
  survive that transition byte-identically and the failed result is stable
  across restarts.

The `titleAdaptation` wire schema this batch had to define is the conservative
author-explicit-replacement v1 described in the README (and enforced by
`src/domain/manuscript.ts`); it participates in the immutable canonical
manuscript BLOB and request digest. Because the postcard paper has no
title/subtitle slot, any non-empty effective title/subtitle fails the operation
with the stable `unsupported_content_slot` — the schema is a protocol safety
boundary, not template capability.

Capability and discovery changes:

- `capabilities.publish = true` **iff** the schema v3 store, the worker and the
  real renderer are available and all four tools are registered; with the
  locked browser cache missing the service still starts, registers all four
  tools and honestly reports `publish: false` (the publish tool then refuses
  work). `renderer` stays `true`; `history`/`device_channel` stay `false`
  (until MCP-04 opens the query surface).
- `service_version` in this batch is `"0.3.0"`; `api_schema_version` stays `1`
  (the database schema and the business API version remain separate identities).
- The SQLite schema moves to version `3` (operation execution facts, global
  publication commit counter, immutable publication/part/edition/page/asset
  families; one-transaction in-place migration from v2 preserving every
  acceptance fact).

Error semantics are unchanged in shape: unknown tool → typed `-32602`; unknown
field/shape → `isError` result with `invalid_input`; storage-layer trouble →
`storage_unavailable` with a fixed message. Nothing fakes success. `published`
remains a server-side commit fact only — no device state (offered, cached,
presented, acknowledged) exists in this service.

## MCP-04 additions (query surface: the tool surface grows to seven)

MCP-04 opens the query tools. `tools/list` now returns exactly seven tools, all
discoverable and callable on every served revision above:

- **`ephemera_history`** (`{ expected_instance_id, limit?, cursor? }`, strict;
  `limit` an integer 1–100 defaulting to 20): one stable snapshot page of the
  authenticated caller's published records ordered by `acceptance_seq` DESC.
  The first call fixes the committed-publication `commit_seq` high water;
  late-completing older tasks and newly published manuscripts never enter an
  opened snapshot (refreshing sees them). `next_cursor` is an opaque 256-bit
  token; the server persists only its SHA-256 digest bound to instance,
  caller, high water, last sort key, page size and a 24h expiry. Unknown,
  expired, tampered, cross-caller, cross-instance and page-size-mismatched
  cursors return one uniform `invalid_input`. Items never contain the
  manuscript, tokens, paths or internal cursor fields; withdrawn and expired
  records stay listed with their facts.
- **`ephemera_peek`** (`{ expected_instance_id }`): the caller's latest
  eligible offer — max by `(eligible_at, acceptance_seq)` over published,
  unwithdrawn records with `eligible_at <= now` and `expires_at > now`, where
  `eligible_at = max(accepted_at, delivery.deliverAfter)`; worker completion
  time never participates. The result carries `device_channel_enabled: false`
  and a `device_status` whose facts are all explicitly null/unknown — nothing
  is inferred from `published`.
- **`ephemera_withdraw`** (`{ expected_instance_id, request_id, publication_id }`,
  strict): idempotent cancellation of future automatic delivery eligibility
  for one of the caller's publications. The `(instance, caller, request)` key
  replays the stored outcome; the same key against a different publication is
  `idempotency_conflict`; unknown/foreign publications are one uniform
  `not_found`. The first call writes a stable `withdrawn_at` plus a ledger row
  in one transaction; nothing is deleted and no device state is claimed.

Capability and version changes:

- `capabilities.history = true` (the query tools read committed SQLite facts
  only and never depend on the renderer); `device_channel` stays `false`;
  `publish` keeps its honest renderer availability rule.
- MCP-04 introduced this seven-tool surface at `service_version = "0.4.0"`.
  MCP-05 keeps the same wire API at `service_version = "0.5.0"` and adds only
  deployment, backup and restore behavior; `api_schema_version` stays `1`.
- The SQLite schema moves to version `4`: publication query columns
  (`deliver_after`/`expires_at`/`eligible_at`/`withdrawn_at`, normalized UTC
  instants backfilled deterministically from the immutable manuscript
  snapshots inside the one migration transaction), the `withdraw_ledger` and
  the `history_cursor` digest table. One-transaction in-place migrations from
  v1/v2/v3 directories preserve every earlier fact; unknown newer versions
  still refuse to start.

Error semantics are unchanged in shape: unknown tool → typed `-32602`;
schema violations (bad limit, unknown fields, illegal request id) → `isError`
result with a recognizable validation message; business violations (cursor,
instance, scope) → stable `invalid_input`/`instance_changed`/`not_found`/
`idempotency_conflict` codes; storage-layer trouble → fixed-message
`storage_unavailable`. Nothing fakes success.

## MCP-05 recovery status

MCP-05 does not register another MCP tool. Backup and restore are full-stop local
administration commands. A normal migration preserves the instance and every wire
fact. A disaster restore rotates the instance and credentials; an operation that was
`accepted` or `processing` in the restored snapshot is exposed through publish replay
and request status as `status: "unknown_after_restore"` with the same stable failure
code. That terminal quarantine is the only additive status value in 0.5.0. The worker
cannot claim it, and replay of its old idempotency key cannot create replacement work.

## Publication v2 (`service_version = "0.6.0"`)

The seven MCP tool names and three negotiated protocol revisions remain unchanged.
`api_schema_version` is now `2` because the accepted manuscript surface and genre
catalog grew:

- Untagged Manuscript v1 stays postcard-only with its original defaults and strict
  field rejection.
- Manuscript v2 is explicitly tagged `schemaVersion: 2`. Its implemented subset
  supports `postcard` and paged portrait `note`; note accepts title, exact body and
  explicit signature, rejects unsupported slots, and has a finite 16-page service
  limit. The list-genres result advertises both supported genres and `max_pages`.
- Request-status, history and peek already carried arrays of pages, so their wire
  shape is unchanged; a note can now return more than one ordered page.

SQLite schema version `5` stores immutable edition sequences and actual layout
snapshots, plus an explicit publication-to-default-edition relation. Migration from
v4 preserves old edition/page/asset IDs and bytes and assigns deterministic sequence
numbers; it does not render historical content. Same-profile future editions no
longer collide with the old `(publication_id, profile)` constraint, and read paths
never select an arbitrary edition.

`capabilities.device_channel` remains `false`. A committed multi-page note proves
server-side publication only; it adds no offered/cached/presented/acknowledged fact.

## Device Channel v1 (`service_version = "0.7.0"`)

The MCP tool list and `api_schema_version: 2` stay unchanged. Device Channel is a
separate HTTP surface and is disabled unless deployment configuration explicitly
enables it. `ephemera_service_info.capabilities.device_channel` mirrors that switch;
the caller-private `ephemera_peek` remains deliberately device-blind and keeps its
existing `device_channel_enabled:false` result.

Enabled deployments provide protocol version 1 with:

- owner-only one-time pairing creation and binding revocation, with an owner bearer
  distinct from MCP and device credentials;
- one-time pairing replay safety, frozen profile/limit negotiation and revocable
  per-binding device bearers;
- channel `screen`, snapshot `history`, explicit-profile/edition `pages`, scoped
  content-addressed gray4 assets, and conditional screen ETags after eligibility is
  recomputed;
- idempotent device events keyed by `(binding_id,event_id)`, a unique persisted
  sequence per binding, append-only late receipts, and a state projection replaced
  only by a newer sequence.

SQLite schema version `6` adds acceptance-time channel routing, immutable
publication/channel deliveries, channel epoch/revision, pairing/binding facts,
device cursors and event/state tables. A normal backup carries the private device
root key so bindings survive a planned move. Disaster restore rotates instance and
epoch and removes every pairing/binding/event continuity fact before reopening;
devices must pair again.

Only `epaper-540x960-gray4-v1` is implemented. The shipped simulator persists its
credential, sequence high water and outbox, downloads each page within finite limits,
and verifies byte length and SHA-256. These tests do not claim physical panel,
touch, memory, sleep or power-loss behavior.
