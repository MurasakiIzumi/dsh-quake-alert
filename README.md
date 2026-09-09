# dsh-quake-alert · QuakeAlert

**English** · [中文](./README.zh.md) · [日本語](./README.ja.md)

> A DeepSeek Harness (DSH) plugin that delivers real-time Japanese earthquake and tsunami alerts (relayed by P2PQuake) while you are using DSH. When an alert matches the regions and thresholds you configured, it notifies you with an alert tone, an in-page toast, and a system notification.

⚠️ **Disclaimer — please read first**: Alert data is relayed by [P2PQuake](https://www.p2pquake.net/), not a direct official feed from the Japan Meteorological Agency (JMA). The content and delivery quality of Earthquake Early Warnings (EEW) are not guaranteed. Alerts from this plugin are **for reference only**; for evacuation decisions always follow the official announcements of the JMA (気象庁). The plugin works only while a DSH page is open.

## Features

- **Real-time push**: a persistent WebSocket connection to P2PQuake; alerts are parsed as soon as they arrive (EEW typically reaches P2PQuake a few hundred milliseconds after the JMA issues it).
- **Automatic reconnection**: exponential backoff (1s → capped at 60s). P2PQuake force-closes connections about every 10 minutes, so reconnecting is normal and needs no intervention.
- **Disaster types**: earthquake reports (code 551), Earthquake Early Warnings (code 556), and tsunami forecasts (code 552).
- **Watch regions**: pick any of Japan's 47 prefectures; leaving the list empty means all of Japan.
- **Alert thresholds**: configured separately for earthquake intensity (observed), EEW intensity (predicted), and tsunami grade (advisory / warning / major warning).
- **Notifications**: synthesized alert tones (Web Audio, one per disaster type) with adjustable volume; in-page toast when the page is visible, system notification when it is in the background. Every headline carries the intensity (observed or predicted), so the alert itself tells you how strong it is.
- **Cancellation notices**: if an EEW you were alerted about is cancelled, or a tsunami forecast you were alerted about is cleared, a short follow-up (descending tone) tells you the earlier alert is void. A cancellation for an event you were never alerted about stays silent (history only).
- **Connection indicator**: a status dot at the sidebar foot — green connected, amber connecting/reconnecting, red stopped — with details on hover.
- **Data source switch**: production (live) or sandbox (replays 2023 history, roughly one message every 30 seconds, for testing).
- **Smart de-duplication**: multiple releases for the same earthquake (intensity prompt → detailed intensity report, or successive EEW updates) notify you only once, and again only when the intensity is upgraded. With several DSH pages open, only one tab plays the alert.
- **History**: the most recent 30 processed messages, including entries that did not reach the threshold; click an entry to expand its details.
- Configuration is stored in browser localStorage — no system dependencies, pure browser.

## How it works

```
P2PQuake WebSocket ──▶ parser (code → unified alert object)
                            │
                            ▼
                  matcher (watch regions × thresholds × 3-layer dedupe)
                            │ hit
                            ▼
            notify: tone + toast (foreground) / system notification (background)
                            │
                            ▼
                recent alert history (persisted in localStorage)
```

- All logic runs in the browser (the Client half); the Host half is only an empty shell required to load the plugin row.
- WebSocket messages carry the same payload as the HTTP `/history` endpoint, but the id field name differs (WS uses `_id`); the parser accepts both.
- Region normalization: area names in EEW / tsunami messages (such as `上川地方北部` or `東京湾内湾`) are resolved through an explicit area table, then by prefix-matching the 47 prefecture names, and finally by the EEW prefecture forecast name. This guarantees that watching a prefecture actually catches its alerts. Areas spanning several prefectures (such as `有明・八代海`) are expanded and evaluated per prefecture.
- Three-layer de-duplication: ① message id (guards against replay after a reconnect) ② event key (multiple releases of the same earthquake; an intensity upgrade still breaks through and alerts again) ③ cross-tab (`BroadcastChannel`, so only one page plays the alert).

## Installation

```sh
# Install from a local directory (development mode: restart dsh web after code changes, no reinstall needed)
dsh plugin --profile web add link:/path/to/this/repo

# Restart dsh web to activate the plugin
```

## Usage

1. Open **Settings → Disaster Alerts** (灾害预警).
2. **Watch regions**: select the prefectures you live in or care about (leave empty for all of Japan).
3. **Alert thresholds**: set the minimum level for earthquake / EEW / tsunami alerts to avoid unnecessary interruptions.
4. **Notifications and sound**: enable the alert tone and/or system notifications and adjust the volume. Use the preview buttons to check the tones, and "Test system notification" to grant permission and verify delivery.
5. **Data source**: keep "Production" for daily use; switch to "Sandbox" to verify the pipeline or see it in action (about one 2023 replay every 30 seconds).

When an alert matches, you get a tone plus a foreground toast or a background system notification, and the event is recorded in "Recent alerts".

## Known limitations

- The plugin runs with the DSH page: closing the page stops it, and browsers may throttle background tabs, delaying notifications.
- Cancellation / clearance notices only fire for events that were previously alerted; a cancellation for an event you never saw stays in the history and does not interrupt you.
- Tsunami forecasts (552) carry no mergeable event id, so successive releases of the same tsunami (added areas, upgraded grade) each notify.
- With several DSH pages open, each page keeps its own WebSocket connection (alerts are de-duplicated via BroadcastChannel, but the number of connections grows with the number of tabs).
- Hypocenter-only reports (551 "hypocenter information" / "distant earthquake") carry no intensity data and cannot be evaluated against thresholds; they are recorded in "Recent alerts" with an explanatory note.
- System notification permission must be granted once via "Test system notification"; the alert tone requires one user interaction before the browser allows it (autoplay policy).
- Coverage is currently Japan (earthquakes / tsunamis); landslides, floods, and global data sources are planned for later versions.
- The sandbox replays mostly small, low-intensity earthquakes, so long periods without a match under the default "intensity 4 or higher" threshold are expected.

## Development

```
client/client.js      # all logic (DSH module-loader format, single file in sections)
lib/index.js          # Host half (empty shell in M1; used in M2 for machine-level settings persistence)
cordis.patch.yml      # plugin row insert declaration
tests/sync-test.cjs   # regression tests for parser / matcher / region normalization (plain node, no browser)
tests/area-tables.cjs # JMA area names and tsunami forecast areas → expected prefectures (test data)
```

```sh
node --check client/client.js && node --check lib/index.js   # syntax check
node tests/sync-test.cjs                                     # regression tests (130 assertions)
```

> `samples/` and `tests/` ship with the repository (plain-text test assets with no external dependencies and no network access), so the regression tests above run right after cloning. They are not part of the npm package (not listed in `package.json` `files`). `DESIGN.md` is an internal design document and is not uploaded to the repository.

## Changelog

Current version **0.1.3**. See [CHANGELOG.md](./CHANGELOG.md) for the details of each release.

## License

MIT © XuZhichao
