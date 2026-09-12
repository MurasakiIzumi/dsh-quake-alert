# dsh-quake-alert · QuakeAlert

**English** · [中文](./README.zh.md) · [日本語](./README.ja.md)

> A DeepSeek Harness (DSH) plugin that delivers real-time disaster alerts while you are using DSH: **Japanese** earthquakes, tsunamis and weather warnings, plus **global** earthquakes (EMSC / USGS) and tsunamis (NOAA). When an alert matches the watch regions and thresholds you configured, it notifies you with an alert tone, an in-page toast, and a system notification.

⚠️ **Disclaimer — please read first**: Alert data is provided or relayed by [P2PQuake](https://www.p2pquake.net/), the Japan Meteorological Agency's public XML feed, [EMSC](https://www.seismicportal.eu/), [USGS](https://earthquake.usgs.gov/) and [NOAA](https://www.tsunami.gov/) — none of them a direct official push channel. The content and delivery quality of Earthquake Early Warnings (EEW) are not guaranteed. Alerts from this plugin are **for reference only**; for evacuation decisions always follow the official announcements of your local authority (the JMA (気象庁) in Japan, NOAA in the United States, and so on). The plugin works only while a DSH page is open.

## Features

- **Real-time push**: a persistent WebSocket connection to P2PQuake; alerts are parsed as soon as they arrive (EEW typically reaches P2PQuake a few hundred milliseconds after the JMA issues it).
- **Automatic reconnection**: exponential backoff (1s → capped at 60s). P2PQuake force-closes connections about every 10 minutes, so reconnecting is normal and needs no intervention. Two silent failure modes are detected and recovered from: a connection that never finishes connecting (no `onopen` within 15 s), and a connection that goes silent after it was established (half-open — no `onclose`, no data for 20 minutes).
- **Disaster types**: earthquake reports (code 551), Earthquake Early Warnings (code 556), and tsunami forecasts (code 552) from P2PQuake, plus **weather alerts from the Japan Meteorological Agency** — landslides (土砂災害警戒情報, 大雨警報（土砂災害）), floods (指定河川洪水予報), heavy rain and storm surges.
- **Watch regions**: pick any of Japan's 47 prefectures; leaving the list empty means all of Japan.
- **Global earthquakes and tsunamis (0.4.0)**: EMSC's live WebSocket push plus USGS's global earthquake catalog (polled by the Host half) cover earthquakes worldwide; NOAA's tsunami CAP messages cover the Pacific and other basins. When the same earthquake arrives from both global sources, it is merged by origin time plus epicenter so you are alerted only once.
- **Global watch points**: express the places you care about as a coordinate plus a radius (up to 20, and "Use my location" fills the coordinates in from browser geolocation). An alert fires when the epicenter falls inside the radius and the magnitude reaches the global threshold (M4.5 by default, adjustable). Japanese earthquakes and tsunamis are unaffected by this and are still judged by prefecture; with no watch point configured, global messages neither alert you nor enter the history.
- **Alert thresholds**: configured separately for earthquake intensity (observed), EEW intensity (predicted), and tsunami grade (advisory / warning / major warning).
- **Notifications**: synthesized alert tones (Web Audio; earthquake / EEW / tsunami / weather / cancellation each have their own tone) with adjustable volume; in-page toast when the page is visible, system notification when it is in the background. Earthquake and EEW headlines carry the intensity (observed or predicted), so the alert itself tells you how strong it is.
- **Cancellation notices**: if an EEW you were alerted about is cancelled, or a tsunami forecast you were alerted about is cleared, a short follow-up (descending tone) tells you the earlier alert is void. A cancellation for an event you were never alerted about stays silent (history only).
- **Quiet hours**: silence non-critical alerts during a daily window (local browser time; a start later than the end crosses midnight). Red-level alerts — EEW, tsunami warnings (Warning and above), intensity 6-lower-or-above earthquakes, and level-4+ weather alerts — still break through unless you turn that off. Suppressed alerts stay in the history.
- **Weather alerts, level 4 and above**: the JMA states an explicit warning level on every weather telegram. Only level 4+ — the "evacuation instruction" grade — is announced; levels 1–3 are still fetched, parsed and listed in the history, and a level-3 hit merely adds one line to the sidebar tooltip. See [Warning levels](#warning-levels-japan).
- **Connection indicator**: a status dot at the sidebar foot — green connected, amber connecting/reconnecting, red stopped — with details on hover.
- **Machine-level persistence**: configuration is stored in DSH's `settings.yaml` through the Host settings service, so it survives across browsers and machines. A browser `localStorage` copy stays as a mirror, and as the fallback when the settings service is unavailable; existing local settings migrate to the Host once, on first run.
- **Municipality-level watch**: narrow earthquake reports down to individual cities / wards / towns / villages, chosen from a searchable per-prefecture list (1,917 entries). Observed-intensity point names are resolved to their municipality first, so the many official spellings all match (大阪北区茶屋町 → 大阪市北区, 福島伊達市 → 伊達市, 渡島北斗市 → 北斗市). Only observed-intensity points carry that granularity; EEW and tsunami stay prefecture-level, and a point that cannot be resolved is treated as a match rather than dropped.
- **Data source switch**: production (live) or sandbox (replays 2023 history, roughly one message every 30 seconds, for testing).
- **Smart de-duplication**: multiple releases for the same earthquake (intensity prompt → detailed intensity report, or successive EEW updates) notify you only once, and again only when the intensity is upgraded. With several DSH pages open, only one tab plays the alert.
- **History**: the most recent 30 processed messages, including entries that did not reach the threshold; click an entry to expand its details.

## How it works

```
P2PQuake WebSocket ──┐   (Japan: earthquake / EEW / tsunami — Client connects directly)
EMSC WebSocket ──────┤   (Global: earthquakes — Client connects directly)
                     ├──▶ parser (→ unified alert object)
JMA Atom feed ───────┤   (Japan: landslides / floods / heavy rain / storm surges)
USGS GeoJSON ────────┤   (Global: earthquake catalog)   Host polls these three,
NOAA CAP ────────────┘   (Global: tsunamis)             Client reads the local route
                                     │
                                     ▼
                 matcher (administrative areas × thresholds / coordinate + radius)
                                     │ hit
                                     ▼
                  notify: tone + toast (foreground) / system notification (background)
                                     │
                                     ▼
                      recent alert history (persisted in localStorage)
```

- All realtime logic runs in the browser (the Client half): the WebSocket connections, parsing, matching, notifications and the history list. The Host half registers the `quake-alert` settings namespace (machine-level `settings.yaml`), serves the read-only municipality and river-forecast-area tables at `/dsh-quake-alert/areas`, and polls the feed for each of the three polled sources.
- **Two realtime links, both Client-direct**: P2PQuake (Japan, sub-second) and EMSC (global). Global earthquake traffic is far sparser than Japan's — an M4+ event arrives roughly every 30 minutes on average — so the EMSC connection **deliberately has its "no data" check turned off**; leaving it on would keep tearing down a perfectly healthy connection and reconnecting. Real disconnects are still caught by `onclose` and the connect watchdog.
- **Three polled sources, one external requester (the Host half)**: the JMA Atom feed (landslides / floods / heavy rain / storm surges, about once a minute), the USGS GeoJSON catalog (global earthquakes, every 2 minutes) and the NOAA event list plus CAP messages (tsunamis, every 5 minutes). The Host remembers which entries it has already fetched and exposes the increment on a local read-only route, `/dsh-quake-alert/feed?source=jma|usgs|noaa&since=N`; the Client polls that route every 15 s and hands each message to the very same `handleAlert` used by P2PQuake messages. Keeping the only external requester on the Host means several DSH tabs or windows never multiply the requests — the JMA explicitly asks consumers not to re-download a file it has already served, and blocks IPs that do. The Client persists a cursor per source, so a refresh resumes where it left off instead of replaying the buffer; a first run (no cursor yet) uses `?since=tail` to align to the current position without replaying anything.
- **Two watch modes coexist**: Japanese sources are judged by prefecture (optionally narrowed to municipalities); global sources carry only an epicenter, so they are judged by spherical distance (Haversine) against your watch points and their radius. Magnitude and JMA intensity are not convertible into one another, which is why global sources get a threshold knob of their own (M4.5 by default).
- WebSocket messages carry the same payload as the HTTP `/history` endpoint, but the id field name differs (WS uses `_id`); the parser accepts both.
- Region normalization: area names in EEW / tsunami messages (such as `上川地方北部` or `東京湾内湾`) are resolved through an explicit area table, then by prefix-matching the 47 prefecture names, and finally by the EEW prefecture forecast name. For JMA telegrams the prefecture is taken from the first two digits of the area code (which _is_ the prefecture code) — more reliable than names, which collide across prefectures. River forecast areas are mapped to their municipalities through a generated table. Areas spanning several prefectures (such as `有明・八代海`) are expanded and evaluated per prefecture.
- Three-layer de-duplication: ① message id (guards against replay after a reconnect) ② event key (multiple releases of the same earthquake; an intensity upgrade still breaks through and alerts again) ③ cross-tab (`BroadcastChannel`, so only one page plays the alert).
- Quiet hours are evaluated after a match: a suppressed alert is still recorded in the history with the reason, and red-level alerts break through by default.

## Installation

```sh
# Straight from GitHub
dsh plugin --profile web add github:MurasakiIzumi/dsh-quake-alert

# Restart dsh web to activate the plugin
```

**Updating**: replace the package contents, then restart `dsh web`. Changes confined to the Client half (`client/`) take effect after a page refresh; anything under `lib/` (the Host half) needs the restart.

## Usage

1. Open **Settings → Disaster Alerts** (灾害预警).
2. **Watch regions**: select the prefectures you live in or care about (leave empty for all of Japan).
3. **Alert thresholds**: set the minimum level for earthquake / EEW / tsunami alerts to avoid unnecessary interruptions.
4. **Global watch points** (0.4.0): if you care about places **outside Japan** — mainland China, Southeast Asia, Europe, the Americas — add a name, latitude, longitude and radius here (up to 20). "Use my location" fills the coordinates in from browser geolocation. An alert fires when the epicenter falls inside the radius and the magnitude reaches "Global earthquakes (minimum magnitude)". With no watch point added, global messages do not interrupt you (and do not enter the history).
   - To verify this path right away: click **"Send test global alert (rotating scenarios)"** just below. It builds EMSC / USGS / NOAA telegrams locally, runs them through the real parsers and matcher, and makes **no network request at all**, so you can click it as often as you like. Four scenarios rotate; the "distant earthquake" one deliberately falls outside the radius to show what the radius does. The result line reports what actually happened.
   - **"Global source status"** shows the EMSC connection plus how many increments each polled source (JMA / USGS / NOAA) has received and how long ago it last polled — so you can confirm the pipeline is alive. Worldwide earthquakes are infrequent by nature; hearing nothing is the normal state.
5. **Disaster types**: three switches — earthquake / EEW, tsunami, and weather alerts (landslides, floods, heavy rain, storm surges). Weather alerts have no threshold: the cut-off is fixed at level 4. **"Send test weather alert (rotating scenarios)"** verifies the whole path with a telegram built locally (no network request); each click rotates through landslide / flood / heavy rain / storm surge, plus an L3 case that deliberately stays silent. The result line reports what actually happened — whether it played, and the reason if it did not.
6. **Notifications and sound**: enable the alert tone and/or system notifications and adjust the volume. Use the preview buttons to check the tones, and "Test system notification" to grant permission and verify delivery.
7. **Data source**: keep "Production" for daily use; switch to "Sandbox" to verify the pipeline or see it in action (about one 2023 replay every 30 seconds).

When an alert matches, you get a tone plus a foreground toast or a background system notification, and the event is recorded in "Recent alerts".

## Known limitations

- The plugin runs with the DSH page: closing the page stops it, and browsers may throttle background tabs, delaying notifications.
- Cancellation / clearance notices only fire for events that were previously alerted; a cancellation for an event you never saw stays in the history and does not interrupt you.
- Tsunami forecasts (552) carry no mergeable event id, so successive releases of the same tsunami (added areas, upgraded grade) each notify.
- With several DSH pages open, each page keeps **two** WebSocket connections of its own (P2PQuake and EMSC). Alerts are de-duplicated via BroadcastChannel, but the number of connections grows with the number of tabs — and P2PQuake enforces a concurrency limit, so opening a great many tabs deserves a thought.
- Several DSH pages **share the same per-source cursors**: a telegram or earthquake already handled by one page is not replayed in another (cross-tab de-duplication only ever lets one page announce it). The trade-off is that a page opened or reloaded later does not add those already-consumed entries to its own "Recent alerts" list.
- Hypocenter-only reports (551 "hypocenter information" / "distant earthquake") carry no intensity data and cannot be evaluated against thresholds; they are recorded in "Recent alerts" with an explanatory note.
- System notification permission must be granted once via "Test system notification"; the alert tone requires one user interaction before the browser allows it (autoplay policy).
- **Coverage**: Japanese earthquakes / EEW / tsunamis come from P2PQuake over a WebSocket, and weather alerts from the JMA's Atom feed (polled by the Host half about once a minute). Outside Japan, coverage comes from EMSC (live push), USGS (global catalog, polled by the Host every 2 minutes) and NOAA (tsunami CAP, polled every 5 minutes). Regional weather sources (the US NWS, Europe's MeteoAlarm, and so on) are planned for a later version.
- **Global sources are coarser than Japanese ones**: they carry only an epicenter and a magnitude, with nothing down to the municipality; tsunamis are expressed as NOAA sea areas (such as `SCOTIA SEA`) rather than Japan's 津波予報区; and landslides / floods outside Japan have no ingestion channel yet.
- **The same earthquake may be reported by both global sources**: if EMSC's and USGS's origin times fall on opposite sides of a minute boundary, the merge fails. The trade-off is deliberate — better to alert twice than to miss one.
- **The EMSC connection does not use the "no data" check**: an M4+ event arrives roughly every 30 minutes worldwide, so silence says nothing about connection health. Real disconnects are still detected and reconnected.
- Weather alerts are deliberately threshold-free: the cut-off is fixed at level 4, so there is no slider to tune — the switch is simply on or off.
- The sandbox replays mostly small, low-intensity earthquakes, so long periods without a match under the default "intensity 4 or higher" threshold are expected.

## Warning levels (Japan)

The JMA states an explicit warning level (警戒レベル) on every weather telegram. This plugin announces **level 4 and above only**:

| Level | What it means in Japan                    | Typical products                                           | What this plugin does                              |
| ----- | ----------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| 1     | Be aware                                  | 早期注意情報                                               | history only                                       |
| 2     | Check your hazard map                     | 大雨注意報、洪水注意報（レベル２…）                        | history only                                       |
| 3     | Elderly and vulnerable residents evacuate | 大雨警報（土砂災害）、洪水警報（レベル３…）                | **sidebar tooltip only** — no sound, no popup      |
| **4** | **Evacuation instruction**                | 土砂災害警戒情報、氾濫危険情報、大雨危険警報、高潮危険警報 | **announced** — tone + toast / system notification |
| **5** | Emergency safety measures                 | 大雨特別警報、氾濫発生情報                                 | **announced**                                      |

Why the cut-off sits at 4: levels 1–2 call for "check the hazard map", which a desktop popup cannot act on, and level 3 is aimed at elderly and vulnerable residents — neither matches how DSH is used. Level 4 is the grade that actually threatens life and property, and it is the grade the JMA labels 「避難指示」. Levels 1–3 are still fetched, parsed and listed under "Recent alerts", so you can always verify the plugin saw them.

## Development

```
client/src/*.js       # client sources: 18 standard ESM modules (explicit import/export; each header states job + deps)
client/client.js      # DSH single-file bundle — GENERATED by rollup, do not edit
lib/index.js          # Host half: settings namespace (schemastery) + the /areas and /feed read-only routes
lib/poller.js         # Host half: generic feed poller (entry de-duplication, ring buffer, cursor; single-stage and two-stage sources)
lib/global-sources.js # Host half: USGS / NOAA feed parsers and endpoints (the JMA parser is still the poller default)
lib/data/cities.js    # municipality table (generated from public data; served to the browser half)
lib/data/river-areas.js   # river forecast areas → municipalities (GENERATED by build-areas.mjs)
scripts/build-client.mjs  # bundles client/src into client/client.js with rollup
scripts/build-areas.mjs   # regenerates lib/data/river-areas.js from the JMA public zip
scripts/lib/zip.mjs   # zero-dependency zip reader shared by the build scripts
scripts/check-imports.mjs # fails on a missing import, or an assignment to an undeclared name
cordis.patch.yml      # plugin row insert declaration
tests/sync-test.cjs   # regression tests: parser / matcher / region normalization / Host poller / feed client / WebSocket state machine (plain node, no browser)
tests/area-tables.cjs # JMA area names and tsunami forecast areas → expected prefectures (test data)
```

```sh
node scripts/build-client.mjs          # rebuild client/client.js after editing client/src
node scripts/build-areas.mjs           # regenerate the river-area table from the JMA public zip (needs network)
node scripts/check-imports.mjs         # cross-module reference check (missing import / undeclared assignment)
node scripts/build-client.mjs --check  # fail when the committed bundle is stale
node tests/sync-test.cjs               # regression tests (561 assertions)
```

> Edit `client/src/*.js`, never `client/client.js` — DSH requires a single-file client bundle (flat module
> graph: one bundle is one module node, no in-package multi-file imports), so the ESM modules are bundled by
> rollup at build time. This is also how DSH's own plugins ship: build output only, multi-file sources.

> `samples/` and `tests/` ship with the repository (plain-text test assets with no external dependencies and no network access), so the regression tests above run right after cloning. They are not part of the npm package (not listed in `package.json` `files`). `DESIGN.md` is git-ignored internal design notes.

## Changelog

Current version **0.4.0** (global phase one: global earthquakes and tsunamis, including local test buttons and a source-status panel). See [CHANGELOG.md](./CHANGELOG.md) for the details of each release.

## Data sources

- Earthquake / tsunami messages: [P2PQuake](https://www.p2pquake.net/) (relaying JMA data), over WebSocket.
- Weather alerts (landslides / floods / heavy rain / storm surges): the JMA's [防災情報XML](https://xml.kishou.go.jp/) Atom feed (`extra.xml`, updated every minute), fetched by the Host half. The river forecast area → municipality table (`lib/data/river-areas.js`) is generated from the JMA's 「指定河川洪水予報区域と市区町村に関するCSVファイル」.
- Global earthquakes: [EMSC](https://www.seismicportal.eu/) (live WebSocket push) and [USGS](https://earthquake.usgs.gov/) (GeoJSON summary, polled by the Host half).
- Global tsunamis: [NOAA / Pacific Tsunami Warning Center](https://www.tsunami.gov/) (CAP 1.2 messages, polled by the Host half).
- Municipality list (`lib/data/cities.js`): compiled from 総務省「都道府県コード及び市区町村コード」(Public Data Utilization Terms, ver. 1.0) plus the designated-city wards of [jp-local-gov](https://github.com/hideo54/jp-local-gov) (MIT). The shipped file is a processed derivative — merged, de-duplicated and grouped by prefecture.

## License

MIT © XuZhichao
