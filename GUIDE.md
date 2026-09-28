# QuakeAlert — how it works, coverage and limitations

**English** · [中文](./GUIDE.zh.md)

The long-form companion to the [README](./README.md). It explains how the plugin is wired together, which
sources it covers, the rules that decide whether you get an alert, what it deliberately leaves out, and
how to build it.

## How it works

```
P2PQuake WebSocket ──┐   (Japan: earthquakes / EEW / tsunami — Client connects directly)
EMSC WebSocket ──────┤   (Global: earthquakes — Client connects directly)
                     ├──▶ parser (→ unified alert object)
JMA Atom feed ───────┤   (Japan: landslides / floods / heavy rain / storm surge)
USGS GeoJSON ────────┤   (Global: earthquake catalog)   Host polls these three;
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

### Client half and Host half

The realtime work all runs in the browser, in the Client half: the WebSocket connections, parsing,
matching, notifications and the history list.

The Host half does three things:

- Wires the `quake-alert` configuration into DSH's settings service. From 0.1.7 the settings form comes
  from the exported `Config` schema; up to 0.1.6 the plugin registered the namespace itself.
- Serves the read-only tables at `/dsh-quake-alert/areas`: municipalities, river forecast areas,
  Chinese administrative divisions and the country / region list. City rows come in per-country chunks
  through `?country=XX`.
- Polls the three sources listed below and exposes their increments at `/dsh-quake-alert/feed`.

### The two realtime links

**P2PQuake** (Japan: earthquakes, EEW, tsunami) is a direct WebSocket connection, and in practice
messages arrive in under a second. P2PQuake force-closes connections about every 10 minutes, so
reconnecting is normal and needs no intervention. The plugin detects and recovers from two silent
failure modes: a connection that never finishes opening (`onopen` never arrives within 15 s), and one
that goes quiet after it was established (`onclose` never arrives, and no data for 20 minutes).

**EMSC** (global earthquakes) is the second direct link. Global M4+ traffic is sparse, averaging roughly
one event every 30 minutes, so the "no data" threshold is deliberately long (3 hours) rather than tight:
a short window would keep tearing down a healthy connection. Real disconnects still show up through
`onclose` and the connect watchdog.

### The three polled sources

The Host half is the only external requester per machine, and it polls:

| Source | Covers | Interval |
| --- | --- | --- |
| JMA Atom feed | Japan: landslides, floods, heavy rain, storm surge | ~1 minute |
| USGS GeoJSON | Global earthquake catalog | 2 minutes |
| NOAA event list + CAP | Global tsunamis | 5 minutes |

The Host remembers which entries it has already fetched and exposes the increment at
`/dsh-quake-alert/feed?source=jma\|usgs\|noaa&since=N`. The Client polls that route every 15 s and
hands each message to the same `handleAlert` that P2PQuake messages go through. Keeping the only
external requester on the Host means several DSH tabs never multiply the requests. The JMA explicitly
asks consumers not to re-download a file it has already served, and blocks IPs that do.

The Client persists a cursor per source, so a refresh resumes where it left off instead of replaying
the buffer. A first run (no cursor yet) uses `?since=tail` to align to the current position without
replaying anything.

### The two overseas sources

The US NWS and Canada's ECCC are queried straight from the browser rather than through the Host. Both
are only usable as per-watch-point queries (NWS `?point=lat,lon`, ECCC `bbox=`), while a full pull would
cost 1.2 GB/day and 144 MB/day respectively. The Host does not know the Client's configuration and
therefore has no watch points, so routing these through the Host would force full pulls. Both APIs
return `Access-Control-Allow-Origin: *` (measured), so the browser can call them directly.

The two are deliberately not unified. NWS `?point=` returns the warnings for the county / zone that
contains the point and does not expand to a radius, so a radius of 25 km or more adds four compass
samples and the radius stays an approximation. ECCC's `bbox` takes the radius directly. Requests are
serial, with a 10 s timeout and a 512 KB body cap, and no watch point in that country means no request
at all.

### Two watch models

The plugin judges Japanese sources by prefecture, optionally narrowed to municipalities. Global sources
carry only an epicenter, so they are matched by spherical distance (Haversine) against your watch points
and their radius. Magnitude and JMA intensity are not convertible into one another, which is why the
global sources have a threshold of their own (M4.5 by default).

The settings page folds both into a single path for the user (pick a country / region first), but two
data models remain underneath. Forcing Japan onto coordinate matching would miss an earthquake whose
epicenter is elsewhere while your own area still reaches intensity 5-lower.

### Region normalization

Area names in EEW and tsunami messages (such as `上川地方北部` or `東京湾内湾`) go through three passes: an
explicit area table, then prefix-matching against the 47 prefecture names, and finally the EEW prefecture
forecast name. For JMA telegrams the prefecture comes from the first two digits of the area code, which
*are* the prefecture code. That is more reliable than names, because 25 names collide across prefectures.
River forecast areas are mapped to their municipalities through a generated table. Areas spanning several
prefectures (such as `有明・八代海`) are expanded and evaluated per prefecture.

WebSocket messages carry the same payload as the HTTP `/history` endpoint, but the id field is named
differently (WS uses `_id`); the parser accepts both.

Municipality-level watching narrows earthquake reports down to individual cities, wards, towns and
villages, picked from a searchable per-prefecture list (1,917 entries). Observed-intensity point names are
resolved to their municipality first, so the many official spellings all match (大阪北区茶屋町 →
大阪市北区, 福島伊達市 → 伊達市, 渡島北斗市 → 北斗市). Only observed-intensity points carry that
granularity. EEW and tsunami stay at prefecture level, and a point that cannot be resolved counts as a
match rather than getting dropped.

### De-duplication

Three layers:

1. **Message id** — guards against replay after a reconnect.
2. **Event key** — multiple releases of the same earthquake notify once; an intensity upgrade still
   breaks through and alerts again.
3. **Cross-tab** — `BroadcastChannel`, so only one page plays the alert.

On top of that, when several agencies report the same earthquake, only the first source to arrive
announces it and the other copies never even enter the history. The test is ±2 minutes + 50 km +
across agencies. Suppressed copies show up in the `authority` section of the diagnostic snapshot instead
of vanishing silently. Two product lines inside the same agency (mainland China's warning → report)
still follow the history-only path.

### Quiet hours

Quiet hours are evaluated after a match: a suppressed alert is still recorded in the history with the
reason. Red-level alerts break through by default: EEW, tsunami warnings and above, intensity
6-lower-or-above earthquakes, level-4+ weather alerts and M7+ global earthquakes. That exception can be
turned off. The window is local browser time, and a start later than the end crosses midnight.

### What enters the history

The history holds the most recent 30 processed messages from the past 5 days, and both limits apply.
Since 0.9.4 it keeps only entries that actually rang, plus the ones the plugin genuinely could not judge:
missing region data, missing coordinates, or a hypocenter-only report with no intensity. Alerts below
your threshold, or from regions you do not watch, are neither announced nor recorded.

## Matching and alerting rules

### Weather warning levels (Japan)

Every JMA weather telegram carries an explicit warning level (警戒レベル). The plugin announces
**level 4 and above only**:

| Level | What it means in Japan | Typical products | What this plugin does |
| --- | --- | --- | --- |
| 1 | Be aware | 早期注意情報 | not announced, not in history |
| 2 | Check your hazard map | 大雨注意報、洪水注意報（レベル２…） | not announced, not in history |
| 3 | Elderly and vulnerable residents evacuate | 大雨警報（土砂災害）、洪水警報（レベル３…） | sidebar tooltip only — no sound, no popup |
| **4** | **Evacuation instruction** | 土砂災害警戒情報、氾濫危険情報、大雨危険警報、高潮危険警報 | **announced** — tone + toast / system notification |
| **5** | Emergency safety measures | 大雨特別警報、氾濫発生情報 | **announced** |

The cut-off sits at 4. Levels 1–2 only call for "check the hazard map", which a desktop popup cannot act
on, and level 3 is aimed at elderly and vulnerable residents. Level 4 is the grade that actually threatens
life and property, and the grade the JMA labels 「避難指示」. Levels 1–3 are still fetched and parsed, and
a level-3 hit adds one line to the sidebar tooltip, but below-threshold telegrams never reach the history.

Weather hazards have fixed boundaries (L4 in Japan, orange in mainland China, `warning` overseas), so
they get an on/off switch and no threshold steps.

### Region filtering and per-region levels

When a message contains at least one area that resolves to a prefecture, areas that cannot be resolved
drop out of prefecture filtering, so one unknown forecast-area name no longer alerts every user. Only when
*every* area is unresolvable does the message pass, preferring an over-alert over silence. Adjusted in
0.4.2.

The L4 broadcast rule looks at the level of the region that matched, not at the telegram maximum. One real
telegram (Hyogo, 2026-09-14) has Himeji at L4 while Aioi is L3 and Nishiwaki is L2; watching only
Nishiwaki no longer produces an overstated "evacuation-level" alert.

### Weather event merging

The plugin merges weather events per (forecast office, hazard) within a 3-hour event window. Updates,
area extensions and continuations of the same hazard from the same office alert once; an intensity
escalation (L3→L4) still alerts again. Crossing an hour boundary, or the same event issued by two
offices, may still alert twice.

There is deliberately no aggregator that folds successive telegrams into one evolving entry, because that
would make it harder to tell which issue you are looking at. Successive telegrams do not ring again
unless the level rises, and a clearance clears the memory, so a re-issue rings again.

### Cancellation notices

When an EEW you were alerted about is cancelled, or a tsunami forecast you were alerted about is
cleared, a short descending tone tells you the earlier alert is void. A cancellation for an event you were
never alerted about stays silent, and only lands in the history.

A tsunami cancellation only matches when the telegram lists the forecast areas. One without a list goes
into the history but does not notify, which avoids presenting some other sea area's cancellation as your
event.

NWS flood alerts carry a real CAP `Cancel`. The event key is NWS's own VTEC tracking number
`<office>.<phenom>.<sig>.<ETN>`, and a cancellation only changes its ACTION segment to `CAN`, so the
plugin matches it to the warning it withdraws and gives it the same "no longer valid" reminder.

ECCC's `status_en` has no verified meaning (a freshly issued frost advisory is also `ended`), so the
plugin never treats it as a cancellation. The two mainland-China feeds have no such field either.

### Timestamps

P2PQuake timestamps are converted from JST to your local time zone in the history details. NWS
timestamps carry their own offset (`2026-09-22T06:51:00-04:00`, varying with state and daylight
saving) and are parsed as-is. JMA, nmc.cn and Wolfx publish bare local times.

### Source health

A source that answers but whose data is old has a state of its own (mid-grey). Past the threshold, the
JMA feed update time or the USGS feed generation time shows up as upstream staleness, distinct from "no
news". A data-format problem shows in blue, since that is not the user's network to fix. The settings
page offers a retry.

## Coverage and data sources

| Coverage | Source | Channel |
| --- | --- | --- |
| Japan earthquakes, EEW, tsunami | [P2PQuake](https://www.p2pquake.net/) (relaying JMA) | WebSocket, Client-direct |
| Japan weather (landslide, flood, heavy rain, storm surge) | JMA [防災情報XML](https://xml.kishou.go.jp/) Atom feed | Host polls ~1 min |
| Mainland China earthquakes | [Wolfx](https://api.wolfx.jp/) relaying CENC | Host holds one connection per source, streams over SSE |
| Mainland China weather (heavy rain, geological disaster) | [nmc.cn](https://www.nmc.cn/) warning list | Host polls every 120 s |
| US weather (flood, flash flood, coastal flood) | [NWS](https://api.weather.gov/) `alerts/active` | Browser-direct, by watch point |
| Canadian weather (rainfall, flood, storm surge) | [ECCC](https://api.weather.gc.ca/) `weather-alerts` | Browser-direct, by bounding box |
| Global earthquakes | [EMSC](https://www.seismicportal.eu/) and [USGS](https://earthquake.usgs.gov/) | EMSC WebSocket; USGS polled by Host |
| Global tsunamis | [NOAA / PTWC](https://www.tsunami.gov/) CAP 1.2 | Host polls every 5 min |

Other regional weather sources (Europe's MeteoAlarm, GDACS) were evaluated and left out: their
granularity, hazard set or coordinate support did not qualify.

Data attribution:

- Municipality table (`lib/data/cities.js`): built from 総務省「都道府県コード及び市区町村コード」(公共データ利用規約 第1.0版) and [jp-local-gov](https://github.com/hideo54/jp-local-gov) (MIT).
- River forecast areas (`lib/data/river-areas.js`): built from the JMA「指定河川洪水予報区域と市区町村に関するCSVファイル」.
- Global city table (`lib/data/world-cities.js`) and Chinese administrative divisions (`lib/data/cn-areas.js`): built from the [GeoNames](https://www.geonames.org/) `cities15000` dump and `admin1CodesASCII.txt` (CC BY 4.0).
- ECCC data: used under the ECCC Data Services End-use Licence v2.1.1 — **Data Source: Environment and Climate Change Canada**, alert content and intent unaltered.

## Known limitations

**Runtime**

- The plugin runs with the DSH page: close the page and it stops, and browsers may throttle background tabs, which delays notifications.
- You have to grant system notification permission once through "Test system notification". The alert tone needs one user interaction before the browser allows it (autoplay policy).
- With several DSH pages open, each page keeps **two** WebSocket connections of its own (P2PQuake and EMSC). BroadcastChannel keeps the alerts de-duplicated, but the number of connections grows with the number of tabs, and P2PQuake enforces a concurrency limit.
- Several DSH pages share the same per-source cursors, so a telegram or earthquake one page has already handled is not replayed in another. A page opened or reloaded later therefore does not add those already-consumed entries to its own history list.

**Alerting semantics**

- Cancellation and clearance notices only fire for events that were previously alerted; a cancellation for an event you never saw stays in the history and does not interrupt you.
- Tsunami forecasts (552) carry no mergeable event id, so successive releases of the same tsunami (added areas, upgraded grade) each notify.
- Hypocenter-only reports (551 "hypocenter information" / "distant earthquake") carry no intensity data and cannot be evaluated against thresholds; they are recorded in the history with an explanatory note.
- The same earthquake may still be reported once by each agency: the cross-source merge window is ±2 minutes + 50 km + across agencies, so when two determinations fall outside it in time or epicenter, each still reports once. Suppressed copies do not enter the history but are counted in the `authority` section of the diagnostic snapshot.
- CENC's warning and report streams are independent. If both cover the same earthquake, the plugin merges them by origin time (minute) plus epicenter (0.1°), and inside one agency they run down the history-only path. If they fall on opposite sides of a minute boundary, or the epicenters differ by more than 0.1°, the merge fails and the same earthquake may alert twice.
- A reconnect can replay up to a full ring buffer (120 entries) over SSE: `/feed` caps a batch at 50 entries, but the SSE replay path does not. Measured, 120 replayed entries cost about 1.8 ms of CPU, and it only happens on reconnect. This is deliberate.

**Source coverage**

- **Global sources are coarser than Japanese ones**: they carry only an epicenter and a magnitude, with nothing down to the municipality. Tsunamis arrive as NOAA sea areas (such as `SCOTIA SEA`) rather than Japan's 津波予報区. Landslides and floods outside Japan have no ingestion channel of their own. The US writes them into the body of a Flash Flood Warning, and the plugin passes the official title and body through verbatim rather than pulling hazard keywords out of prose.
- **The mainland-China EEW threshold sits around M4.0**: the warnings themselves are sparse (a few days apart in practice), so you will receive noticeably fewer alerts than for Japan. The reports stream (which does have data daily) has its own magnitude threshold, M4.5 by default.
- **The Chinese push channel can be downgraded**: the page uses an SSE long connection (seconds of latency). A network middlebox can cut it: EventSource unavailable, no first data after repeated attempts, or connected but not streaming. When that happens the plugin falls back to 15-second polling on its own, saying so under "Source status". Polling can also be forced there.
- **The Wolfx relay's REST fallback is unverified against the live endpoint**: when the WebSocket to the Wolfx relay is not connected, the Host polls `https://api.wolfx.jp/<source-id>.json` (for example `cenc_eqlist.json`). `api.wolfx.jp` is unreachable from the author's network, where the TLS handshake is cut the same way `download.geonames.org` is, so only unit tests with injected fetchers cover the endpoint's real shape. Run `node scripts/check-wolfx-live.mjs` on a network that can reach it to confirm.
- **The Chinese sources carry no cancellation or final-report flag (safety-relevant)**: neither CENC stream has a "cancelled" or "final" field, so if an alert already announced to you is later withdrawn or revised upstream, the plugin cannot send a follow-up saying it is void. For anything you receive, defer to CENC's own official release.
- **The mainland weather source has no "cleared" flag either**: nmc.cn's warnings are a "currently in force" set, so an expired warning simply vanishes from the list and the plugin never sees a "cleared" action. Orange is mapped faithfully to the official level (orange ≠ red), while quiet hours release red only by default, so an orange warning issued at night leaves a trace in the history and nothing more.

**Overseas weather sources (NWS / ECCC)**

- The US radius is an **approximation**: NWS judges by county / zone and the radius only adds four samples, so the plugin cannot guarantee coverage of every county inside the radius.
- **ECCC does not cover river floods**: river-flood warnings in Canada are issued by provincial agencies (such as the BC River Forecast Centre) with no national API, while ECCC issues weather warnings and coastal storm-surge warnings. "The plugin is installed" must not be read as "somebody is watching Canada's floods".
- **Neither source can detect an upstream stall**: a per-point or per-box query is legitimately empty, so "no data this round" and "the upstream stopped" look identical. Only request failures and schema drift show up. The NWS is key-free today but has said its User-Agent string will become an API key; at that point direct browser calls stop working and the Host half would have to come back in.
- **ECCC has no reliable "ended" signal**: its `status_en` does contain `ended` / `continued`, but a freshly issued frost advisory is also `ended`, so the meaning is unverified and ECCC's `cancelled` is always false. An expired ECCC warning never produces a follow-up saying it is void.
- **ECCC's hazard whitelist is the only part of this design not backed by measurements**: its code table has no official enumeration and there are no rainfall samples in the current season, so the whitelist is built from English-name keywords and needs calibrating once real rainfall warnings arrive.
- **Age rule**: alerts already issued more than 6 hours before you open the page are recorded without ringing, and a page that has been asleep for over 30 minutes is treated the same way on wake.
- **The NWS whitelist matches `properties.event` exactly and cannot be graded by `severity`**: a `Flood Watch` is also `Severe`, and a `Coastal Flood Watch` is `Moderate`, so severity does not separate a warning from a watch. Only `Warning`-class events are announced (Flood / Flash Flood / Coastal Flood Warning).
- **ECCC contributes `warning`-class alerts only**: frost and fog are advisories by ECCC's own definition, while wind, heat and thunderstorms *are* warnings but fall outside this plugin's hazard scope.

**Configuration**

- **A wrongly typed value in the locally saved config falls back to browser storage**: if a value in the Host's settings file fails schema validation, the plugin uses the configuration kept in the page's localStorage instead. On the 0.1.6 path a warning was visible; on the current one the rejection happens on the Host side and this plugin never sees it, so the only symptom is "the value I edited did not take effect". What fails validation is a value outside the declared ranges or of the wrong type; the plugin does not merge partially valid objects.
- The **status / diagnostic layer** (connection, backoff, stalled feeds, parse failures) is deliberately **English-only and kept short**: about 70 strings, and only a person reading the sidebar or pasting a diagnostic snapshot ever looks at them. Everything the plugin composes for an alert itself follows the interface language, in all four languages: type labels, intensity and tsunami grade words, match reasons, the `（未命中：…）` suffix in the history, and the test-telegram dropdown in the settings page. Wording that comes from a source is passed through verbatim: JMA's own Japanese sentences, place names, agency names, NWS / ECCC official event names.
- The global city table only contains towns of 100,000+ inhabitants, so small towns and villages are missing from it. Use the coordinate form or "Use current location" when you need one. Cities with the same name inside one country get their first-level administrative area appended to the name ("Springfield (Illinois)"), and that area name is in English, because GeoNames only provides Latin-script names. It only affects how readable the list is and takes no part in matching.
- City names in the global table are plain Latin while country names are localized. City names used to come from GeoNames' `alternatenames`, preferring a CJK candidate, so one table mixed Simplified, Traditional and Japanese forms (Rome read 羅馬 while its administrative area was the Latin "Lazio"). Localizing them would need GeoNames' language-tagged candidates (`alternateNamesV2`, a much larger download), so they are uniformly Latin instead (Rome / Milan / New York City; none of the 5224 entries contains a Han character). Country / region names come from ICU per interface language rather than from a table. Regenerating the city table needs the GeoNames dump: `node scripts/build-world-cities.mjs` (it downloads the dump, or reads a local copy with `--from <directory>`).

**Sandbox**

- The sandbox replays mostly small, low-intensity earthquakes, so long periods without a match under the default intensity threshold are expected.

## Development

```
client/src/*.js       # client sources: 37 standard ESM modules (explicit import/export; each header states job + deps)
client/client.js      # DSH single-file bundle — GENERATED by rollup, do not edit
lib/index.js          # Host half: settings namespace (schemastery) + the /areas and /feed read-only routes
lib/poller.js         # Host half: generic feed poller (entry de-duplication, ring buffer, cursor; single-stage and two-stage sources)
lib/global-sources.js # Host half: USGS / NOAA feed parsers and endpoints (the JMA parser is still the poller default)
lib/wolfx-source.js   # Host half: Wolfx relay (CENC EEW / rapid reports), WebSocket with REST fallback and a ring buffer
lib/nmc-source.js     # Host half: nmc.cn warning-signal list, plus detail-page text extraction
lib/data/cities.js    # municipality table (generated from public data; served to the browser half)
lib/data/cn-areas.js  # Chinese administrative divisions (provinces → prefecture-level cities + coordinates, GENERATED by build-cn-areas.mjs)
lib/data/world-cities.js  # global city table (166 countries / 5224 cities, served per country, GENERATED by build-world-cities.mjs)
lib/data/river-areas.js   # river forecast areas → municipalities (GENERATED by build-areas.mjs)
scripts/build-client.mjs  # bundles client/src into client/client.js with rollup
scripts/build-areas.mjs   # regenerates lib/data/river-areas.js from the JMA public zip
scripts/build-cn-areas.mjs # regenerates lib/data/cn-areas.js from the official administrative-division data (needs network)
scripts/build-world-cities.mjs # regenerates the global city table from the GeoNames dump (needs network)
scripts/lib/zip.mjs   # zero-dependency zip reader shared by the build scripts
scripts/lib/geonames.mjs  # reads and parses the GeoNames dumps by column (shared by the two table scripts)
scripts/check-imports.mjs # fails on a missing import, or an assignment to an undeclared name
cordis.patch.yml      # plugin row insert declaration
tests/sync-test.cjs   # regression tests: parser / matcher / region normalization / Host poller / feed client / WebSocket state machine (plain node, no browser)
tests/area-tables.cjs # JMA area names and tsunami forecast areas → expected prefectures (test data)
```

```sh
node scripts/build-client.mjs          # rebuild client/client.js after editing client/src
node scripts/build-areas.mjs           # regenerate the river-area table from the JMA public zip (needs network)
node scripts/build-cn-areas.mjs        # regenerate the Chinese administrative-division table (needs network)
node scripts/build-world-cities.mjs    # regenerate the global city table from the GeoNames dump (needs network)
node scripts/check-imports.mjs         # cross-module reference check (missing import / undeclared assignment)
node scripts/build-client.mjs --check  # fail when the committed bundle is stale
node tests/sync-test.cjs               # regression tests
node scripts/check-time-travel.cjs 180 # clock-shift check: move the system clock forward 180 days and rerun the suite
node scripts/check-contracts.mjs       # contract check: pull the live sources through the parsers (--offline uses samples/, no network)
```

`tests/sync-test.cjs` loads the **built** `client/client.js`. After editing `client/src/`, always run
`node scripts/build-client.mjs` first, or you are testing the previous build. One-liner:
`node scripts/build-client.mjs && node tests/sync-test.cjs`.

On Windows, if `pnpm` fails with "cannot be loaded because running scripts is disabled", use
`pnpm.cmd check` / `pnpm.cmd test` (or `npx pnpm check`). `pnpm check` only verifies the bundle is
current; `pnpm test` rebuilds and then runs the regression suite.

Edit `client/src/*.js`, never `client/client.js`. DSH requires a single-file client bundle (flat module
graph: one bundle is one module node, with no in-package multi-file imports), so rollup bundles the ESM
modules at build time. DSH's own plugins ship the same way: the build output is what gets loaded, while
the sources stay multi-file. This repository's npm package ships both. `package.json` `files` includes the
whole `client/` directory, so `client/src/` is in the package too, while `samples/`, `tests/` and
`scripts/` are not.

`samples/` and `tests/` ship with the repository, so the regression tests run right after cloning.
Neither needs network access or an external dependency.

## License

MIT © XuZhichao
