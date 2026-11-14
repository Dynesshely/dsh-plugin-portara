# Design notes

## Goal

Show the gateway routing facts for a reply inside the conversation stream, at the same visual level as a
tool-call row, without touching the DSH kernel and without ever degrading a model call.

## Decisions

### 1. The durable channel is a `plugin:` record, not a new event type

The natural-looking implementation — declare `portara/route` in `SessionEventMap` and call
`session.append('portara/route', …)` — **breaks the session log**. `Session.append()` cannot set the
`ignorable` envelope marker, and the persistence read path refuses any stored event whose type is outside
`KNOWN_SESSION_EVENT_TYPES` unless that marker is present. The Session then fails to reopen
(`SessionFormatUnsupportedError`). That is a catastrophic failure for a cosmetic feature.

`appendPluginRecord()` is the supported writer for log-only records: it names the event under `plugin:`,
sets `ignorable: true`, keeps it off the model-visible surface, and carries it through fork, resume, and
format migration. Readers that do not know the type retain and skip it. This is the only path that keeps
"open the conversation again" working.

One subtlety makes it non-trivial for an out-of-repo plugin: `appendPluginRecord()` commits through a
module-private binding whose closure checks the private brand of the `Session` class. Calling it from a
*different copy* of `@deepseek-ai/dsh-session` throws `TypeError`. The Host may load that package from
source (a source checkout runs it through the TypeScript loader) or from its build output, so the plugin
resolves the package from the profile's own `node_modules`, tries the source entry and then the built one,
and keeps the first candidate that accepts a real append. Failure is silent and the card is simply absent.

### 2. The session key needs an explicit header

The gateway resolves its session key in this order: `x-portara-client-session`, then
`x-deepseek-harness-session-id`, then the request body's `prompt_cache_key`. The deepseek adapter sends the
second header, but the pi-ai adapter used for gateway routes does not: it maps the session id to its own
affinity headers and `prompt_cache_key`. The explicit key and the `prompt_cache_key` key are hashed under
different prefixes, so a query carrying only the session id would read a *different* bucket than the
requests it is supposed to describe.

The plugin therefore stamps the explicit header itself, through the public
`llm-pi-ai/request-headers` waterfall (the request object is deep-frozen, so the header is the only
writable surface). The header is added only for endpoints confirmed as gateways; discovery probes the
configured provider endpoints once at activation and treats an endpoint that answers as a `route.info`
data plane as a gateway. The probe answer is structurally valid even when routing disclosure is off, so
discovery reveals nothing.

### 3. Read the route after the call, poll while it runs

`llm/stream` wraps the chunk stream, so the query runs in `finally` — every successful and failed call is
covered. `request.purpose` skips auxiliary calls (titles, searches, subagent side work) that would only add
noise. While the stream is open an interval polls the same endpoint; the first record that changes the
routing facts is committed, and the interval stops in the same `finally`.

The query has a hard timeout (1.5 s by default), is bounded in body size, and resolves every failure to
"no record". Nothing about it can fail or slow the request path.

### 4. One card per Turn, keyed by the session and the Turn number

Each Turn that observed a route gets its own card: the match id is
`<gateway session key>#<turn>`, so records from one Turn update one row and later Turns get their own.
Dedupe still runs on the observed routing facts, so a repeated query never stacks a second card.

### 5. The card sits at the opening of the Turn's assistant content

A record is written when a model call settles, inside the Turn's Step. Anchoring the node at the record
would put the card near the reply; anchoring at `turn/start` would put it *above the user's prompt*. The
plugin instead anchors at the Turn's first loaded `step/start` — the earliest event after the round's input
is claimed — and gives the node the `turn` group-tree position. The card therefore renders between the
prompt and the process disclosure, stays visible when the process is folded, and, because each Turn owns a
separate Context, paging in older history can only add older cards — it cannot move or lose an existing one.

### 6. Copy and styling

Card copy is registered into the client locale service under the plugin's own namespace; the exported
`locale/*.json` files carry the plugin-manager title and description. Styling uses the `--dsw-alias-*`
theme tokens only, so light/dark switching works without literal colors. The row is a compact summary line
plus an optional disclosure list of failover attempts; nothing is written outside the component, and a
malformed payload renders nothing rather than crashing the slot.

### 7. `/portara route` answers the UI, not the model

A command handler returns `CommandResult` text that the dispatching composer renders directly. That makes
`/portara route` a zero-token query: it bypasses the model, resolves the confirmed gateways (running a
discovery pass first if the command beats the first model call), queries `/v1/route-info` with the session
id, prints channel/account/upstream model plus failover history, and refreshes the card through the normal
dedupe path. When the live query has nothing — the gateway keeps its current-route cache for fifteen
minutes, so a conversation that has been idle reports empty — the command falls back to the newest
`plugin:portara/route` record in the session log and labels it as the last recorded route. The verb grammar
and the formatting are pure functions in `src/host/command.js`, so both are unit-tested without a gateway.

## Rejected alternatives

- **Appending a real event type** — makes the session unreadable on load (see 1).
- **Client-side polling of the gateway** — the API key lives in the Host process; the browser must never
  hold it.
- **Host projection with `wire.view`** — a projection state is a pure fold of session events, so it cannot
  carry out-of-band gateway facts without inventing an event to fold.
- **A fixed `prompt_cache_key`** — the harness derives that value per call; the plugin must not rewrite the
  request body of a frozen loop-built request.
