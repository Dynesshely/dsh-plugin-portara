# dsh-plugin-portara

A DeepSeek Harness bundle that shows **where each reply was actually served** when the model route is a
[Portara](https://github.com/Crequency/Portara) gateway: the channel, the upstream account, the upstream
model, and every failover attempt behind the answer.

The card renders in the chat stream at the same level as a tool-call row and is collapsible.

```text
⚡ Switched to OpenDesign / ACP-003 (attempt 2) · deepseek-v4.1-flash   ▸
```

## What it does

| Half | Seam | Effect |
| --- | --- | --- |
| Host | `llm-pi-ai/request-headers` | stamps the harness session id as `x-portara-client-session`, so the gateway and the plugin hash the same session key |
| Host | `llm/stream` | after each conversation call (successful or failed) queries `GET <baseURL>/route-info`, optionally polling while the call is in flight |
| Host | `appendPluginRecord()` | writes one `plugin:portara/route` record — an ignorable, log-only event that older readers retain and skip |
| Client | `uiConversation.events.register()` | one Chat row per gateway session key; later records update that row instead of stacking |
| Client | slot `conversation.chat.node` | renders the collapsible row, localized in English and Chinese |

No DSH kernel file is modified. The plugin only uses published seams.

## Install

```bash
dsh plugin install /home/<you>/projects/Dynesshely/dsh-plugin-portara
# or from the Web UI: Plugin manager → install a local bundle
```

Installing a new bundle can activate through the loader's hot reload; no `dsh` restart is required for the
host half. A page reload picks up the browser half.

Enable routing disclosure on the gateway when you want channel and account names. The gateway hides them
by default:

```bash
# gateway settings (gated by its own admin surface)
exposeRoutingInfo: true
exposeRoutingDetail: channel   # off | alias | channel
```

With disclosure off, the endpoint answers with an empty structure and this plugin writes nothing — no card
and no error. In that state the plugin is also not observable at all: it does not poll the gateway while a
reply streams, because the first answer already proved there is nothing to show.

The current deployment of the gateway answers `exposeRoutingInfo: false`, so the card is invisible until
that switch is turned on at the gateway (Settings → 网关 → 暴露路由信息, or `PATCH /api/settings`).

## Configuration

All keys are optional; the defaults work without configuration.

```yaml
- insert:
    - id: portara-route
      name: dsh-plugin-portara
      config:
        enabled: true             # false disables observation entirely
        timeoutMs: 1500           # route-info query budget; clamped to 100…10000
        pollIntervalMs: 2000      # in-flight polling of failover history; 0 disables
        injectSessionHeader: true # send x-portara-client-session only to confirmed gateways
        gateways:                 # optional explicit gateways (skips discovery)
          - baseURL: https://portara.example/v1
            apiKeyEnv: PORTARA_AI_GATEWAY_API_KEY
```

Gateway discovery reads the live model-provider configuration: every provider that declares a `baseURL`
and an `apiKeyEnv` is probed once, and an endpoint that answers as a `route.info` data plane is treated as
a gateway. The API key is resolved through the credentials service, falling back to the process
environment.

## Behaviour guarantees

- **Silent by contract** — unreachable gateway, timeout, non-200, oversized body, malformed JSON, or a
  missing session all resolve to "write nothing". No error surfaces in the chat, and no model call fails or
  slows down because of this plugin.
- **Reload-safe records** — `Session.append()` cannot set `ignorable`, and an unknown non-ignorable event
  would make the Session unreadable on the next load. The plugin therefore writes only `plugin:` records
  through `appendPluginRecord()` and resolves the Host's own Session module instance first, because a
  second copy of the module cannot brand the Host's `Session`.
- **No duplicate cards** — records are deduped by the observed routing facts, and every record of one
  gateway session key updates the same Chat row.
- **No secrets** — the API key stays in the Host process; records carry only the routing facts the gateway
  chose to expose. Nothing is logged.

## Tests

```bash
npm test      # node:test: payload, gateway client, provider discovery, client helpers, Host integration
npm run check # node --check on every shipped source file
```

The Host integration test creates a real (independent) `Session`, a local HTTP gateway, and a temporary
profile whose `node_modules` links the installed `@deepseek-ai/dsh-session`, so the record path is exercised
without a running Harness. It skips itself when that package cannot be resolved.

## Layout

| Path | Purpose |
| --- | --- |
| `index.js` | host entry (`apply`, `inject`, `name`) |
| `src/payload.js` | durable payload normalization and dedupe signature |
| `src/host/gateway.js` | timeout-bounded, silent route-info client |
| `src/host/provider.js` | provider discovery, credential resolution, session-header decision |
| `src/host/records.js` | Host Session module resolution and plugin-record append |
| `src/host/index.js` | listener wiring, polling, dedupe |
| `client.js` | browser half: Conversation Definition, Chat row renderer, locale copy |
| `docs/DESIGN.md` | why the seams and the record format are what they are |

## License

MIT
