# Changelog

All notable changes to this bundle are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-11-15

### Added

- `/portara route`: prints the session's gateway route once — channel, account, upstream model, and the
  failover attempts — without spending a model call. Falls back to the session's last recorded route when
  the gateway's 15-minute live cache has expired, and says so.
- The turn status row carries the full routed model id together with the channel and account.
- A build stamp in the card and status-row tooltips, so a stale page can be told apart from a fresh bundle.

### Changed

- One collapsible route card per conversation Turn (keyed by gateway session and Turn number) instead of one
  per session.
- Each card is anchored at the start of its Turn's assistant content — after the user's prompt and the
  completion header, before the first process row — and stays visible while the process is folded.
- The Host stamps every record with the Turn's prompt sequence, so placement no longer depends on which
  history window the page has loaded.

### Fixed

- The route card no longer drifts to the end of a Turn, above the next prompt, or out of view when older
  history is loaded.
- A gateway with routing disclosure off no longer causes polling: the plugin stops asking until a settled
  query sees routing facts again.

## [0.1.0] — 2026-11-14

### Added

- Host half that queries the gateway's route-info data plane after every conversation call and writes
  reload-safe `plugin:portara/route` records.
- Browser half that renders a collapsible routing card in the chat stream, localized in English and Chinese.
- Session-key alignment through the `llm-pi-ai/request-headers` waterfall.

[0.1.1]: https://github.com/Dynesshely/dsh-plugin-portara/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Dynesshely/dsh-plugin-portara/releases/tag/v0.1.0
