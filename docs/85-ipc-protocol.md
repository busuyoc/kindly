# 85 — `kindly serve` IPC Protocol

**Audience:** anyone building a GUI, editor plugin, or automation tool on top
of a long-running `kindly` process. If you're invoking `kindly <cmd>` as a
one-shot and parsing `--json` output, you want [82-json-api.md](./82-json-api.md)
instead.

**Status:** `$serve_protocol: 1`. Frozen within the v1.x major. New versions
will bump the integer and be advertised in the hello message.

**Source of truth:**
- Loop: [`src/cli/serve.ts`](../src/cli/serve.ts)
- Command envelopes: [`docs/82-json-api.md`](./82-json-api.md)
- Error codes: [`src/types/errors.ts`](../src/types/errors.ts)

If this doc disagrees with the code, the code wins — file a bug to update the
doc. Canonical wire examples live in `tests/fixtures/serve/`.

---

## 1. Why a separate process

Bun startup + TypeScript module load for `kindly` is ~30ms on a warm Mac. For
a GUI that polls `doctor` or re-runs `diff` on every settings edit, that
dominates the perceived latency. The W26 benchmark (`scripts/bench-serve.ts`)
shows the argv-passthrough design delivers **85× faster** warm requests than
cold spawns (421µs vs 36.2ms per `doctor --json` on a fake-Kindle tmpdir).

The design is deliberately **not** JSON-RPC 2.0. Every `kindly` command
already has a stable `--json` envelope ([82-json-api.md](./82-json-api.md)) and
a hand-rolled flag parser. Requiring callers to re-encode argv as named
parameters would double the surface to keep in sync. Instead, serve is a thin
wrapper: the request is the same argv you'd pass on the shell, and the
response is the same envelope you'd get back.

---

## 2. Transport

- **Channel:** stdin (requests) and stdout (responses), UTF-8.
- **Framing:** line-delimited JSON. One JSON object per line, terminated by
  `\n`. Lines are CRLF-tolerant (a trailing `\r` is stripped before parsing).
- **No keep-alives, no acks.** Every request gets exactly one response. There
  is no server-initiated push (watch mode is a separate command — see W29).
- **Blank lines are ignored.** An empty line between messages is a no-op; use
  it for debugging by hand without confusing the parser.
- **EOF ends the session.** When the parent closes stdin the loop drains any
  remaining line and exits 0.
- **Ordering:** responses are emitted in the order `handleRequest` completes.
  Requests are processed serially in the current implementation, so responses
  match request order. Clients MUST still correlate by `id` and not assume
  FIFO — that guarantee is not part of the protocol.

### 2.1 Chunk splitting

A chunk arriving on stdin is not guaranteed to be a complete line — it may
contain partial lines or multiple lines. Serve buffers until it sees `\n`
before parsing. Clients implementing the same framing MUST do the same.

---

## 3. Version handshake

Immediately on startup, before reading any input, serve writes one line to
stdout:

```json
{"$serve_protocol":1,"kindly_version":"0.10.0","ready_at":"2026-04-22T12:00:00.000Z"}
```

Clients MUST wait for this hello line before sending requests. Fields:

| Field | Type | Notes |
|---|---|---|
| `$serve_protocol` | integer | Wire version. Currently `1`. Bumped on breaking changes. |
| `kindly_version` | string | Semver of the `kindly` binary. Advisory only — do not parse features from it. |
| `ready_at` | string | ISO-8601 UTC timestamp. Handshake-only; not used for timing. |

**Version negotiation policy.** A client that speaks `$serve_protocol: N`
MUST refuse to talk to a server advertising a higher or lower major. We
expect additive fields on requests and responses to be introduced without a
version bump — all consumers MUST ignore unknown keys. Removals or shape
changes bump the version.

Canonical example: [`tests/fixtures/serve/hello.json`](../tests/fixtures/serve/hello.json).

---

## 4. Request

One JSON object per line:

```json
{"id": 1, "argv": ["doctor", "--mount", "/tmp/fake-kindle"]}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | number \| string | yes | Opaque correlation token. Echoed verbatim in the response. Numeric IDs are conventional, but strings are accepted for UIs that want per-panel namespacing. |
| `argv` | string[] | yes | The same argv you'd pass to `kindly` on the shell — `argv[0]` is the command name. |

### 4.1 `--json` is auto-injected

If `argv` does not already contain `--json`, serve prepends it. This is the
only rewrite serve performs. Every command response is therefore a parseable
envelope; a command falling back to text output would break line-framing.

### 4.2 Command whitelist

`argv[0]` must be one of:

```
apply, diff, doctor, history, init, plugin, pull, restore, rollback, setup, snapshot
```

Excluded:

- **`serve`** — no recursive spawn.
- **`help`, `--version`** — no envelope shape.

Unsupported commands produce a framing error (see §6) rather than bubbling
through the CLI dispatcher. This means a fresh command added to the CLI also
needs to be added to `COMMAND_WHITELIST` in `src/cli/serve.ts` before serve
will forward it.

### 4.3 Inherited context

Per-request output is captured into a `StringWriter`, but `cwd`, `mount`
override, `color`, and `now()` are inherited from the serve process's own
env. A long-running serve therefore points at exactly **one** device — if the
user swaps Kindles, the client should respawn `kindly serve` or use
`--mount` on each request to override.

Canonical example:
[`tests/fixtures/serve/request-doctor.json`](../tests/fixtures/serve/request-doctor.json).

---

## 5. Response

### 5.1 Success

```json
{"$serve_protocol":1,"id":1,"envelope":{"$schema_version":1,"ok":true,"command":"doctor","data":{"...":"..."}}}
```

| Field | Type | Notes |
|---|---|---|
| `$serve_protocol` | integer | Matches the hello. |
| `id` | number \| string | Echoed from the request. |
| `envelope` | object | The command's standard `--json` envelope ([82-json-api.md](./82-json-api.md)). Shape depends on `envelope.command`. |

The envelope carries its own `ok` / `error` — a command-level failure (e.g.
missing mount, schema violation) is reported **inside** `envelope`, not as a
framing error. Serve only produces a framing error when transport itself is
broken.

Canonical example:
[`tests/fixtures/serve/response-doctor.json`](../tests/fixtures/serve/response-doctor.json).

### 5.2 Two-layer error model

Clients must distinguish two failure modes:

1. **Framing error** (§6). The request never reached a command, or the command
   produced output the loop can't forward. Shape: `{error: {code, message}}`
   at the top level, no `envelope` key.
2. **Command error.** The command ran and produced an error envelope. Shape:
   `{envelope: {ok:false, error:{code, message, …}}}` — framing is fine.

A correct client treats them differently in UI: framing errors indicate a
bug in the client or a `kindly` version mismatch; command errors are the
user's data / device state.

---

## 6. Framing errors

Emitted with `error` in place of `envelope`:

```json
{"$serve_protocol":1,"id":null,"error":{"code":"BAD_REQUEST","message":"invalid JSON: ..."}}
```

| `code` | When |
|---|---|
| `BAD_REQUEST` | Malformed JSON, non-object, missing/ill-typed `id` or `argv`. `id` may be `null` if it couldn't be recovered. |
| `UNSUPPORTED_COMMAND` | `argv[0]` is missing or not in the whitelist. |
| `INTERNAL` | Exception escaped the dispatcher, command produced no envelope despite exiting, or envelope output was non-JSON. |

These codes are stable. Adding a new framing condition gets a new code — it
does not repurpose an existing one.

---

## 7. Lifecycle

1. Client spawns `kindly serve`. No argv is permitted (extra arguments → exit
   code 2 with a stderr message before the loop starts).
2. Client reads one line from stdout → hello.
3. Client writes request lines to stdin, reads response lines from stdout, in
   parallel. Responses correlate by `id`.
4. Client closes stdin when done. Serve drains, writes any final responses,
   exits 0.
5. If the client wants a hard stop, sending SIGTERM is safe — serve holds no
   locks between requests.

---

## 8. Client implementation notes

- **Buffer until `\n`.** Both stdin chunks (server side) and stdout chunks
  (client side) can split mid-line. Hold a trailing partial line across reads.
- **Reuse one serve process per device session.** Spawning on demand throws
  away the startup amortization that's the whole point.
- **Don't pipeline assumptions.** Requests currently run serially, but the
  wire protocol does not guarantee ordering forever. Always correlate by
  `id`.
- **Respect the whitelist.** If the GUI needs a command not on the list, add
  it explicitly rather than falling back to spawning `bun run`. Cold spawn
  latency will confuse UX.
- **Treat `kindly_version` as advisory.** Feature detection should be based
  on response envelope shape, not on parsing semver.

---

## 9. Examples

A minimal round trip (hello → doctor request → response):

```text
< {"$serve_protocol":1,"kindly_version":"0.10.0","ready_at":"2026-04-22T12:00:00.000Z"}
> {"id":1,"argv":["doctor","--mount","/tmp/fake-kindle"]}
< {"$serve_protocol":1,"id":1,"envelope":{"$schema_version":1,"ok":true,"command":"doctor","data":{...}}}
```

A framing error (bad JSON):

```text
> {"id":1,"argv":
< {"$serve_protocol":1,"id":null,"error":{"code":"BAD_REQUEST","message":"invalid JSON: ..."}}
```

A command error (valid request, command fails):

```text
> {"id":2,"argv":["pull","--mount","/does/not/exist"]}
< {"$serve_protocol":1,"id":2,"envelope":{"$schema_version":1,"ok":false,"command":"pull","error":{"code":"MOUNT_NOT_FOUND","message":"...","remediation":[...]}}}
```

---

## 10. Changelog

- **2026-04-22 — v1 frozen.** W28 spec published. No wire changes from W26.
