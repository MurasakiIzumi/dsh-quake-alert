# dsh-quake-alert · QuakeAlert

**English** · [中文](./README.zh.md) · [日本語](./README.ja.md)

> A DeepSeek Harness (DSH) plugin that delivers real-time disaster alerts while you are using DSH: **Japanese** earthquakes, tsunamis and weather warnings, plus **global** earthquakes (EMSC / USGS) and tsunamis (NOAA). When an alert matches the watch regions and thresholds you configured, it notifies you with an alert tone, an in-page toast, and a system notification.

⚠️ **Disclaimer — please read first**: Alert data is provided or relayed by [P2PQuake](https://www.p2pquake.net/), the Japan Meteorological Agency's public XML feed, [EMSC](https://www.seismicportal.eu/), [USGS](https://earthquake.usgs.gov/) and [NOAA](https://www.tsunami.gov/) — none of them a direct official push channel. The content and delivery quality of Earthquake Early Warnings (EEW) are not guaranteed. Alerts from this plugin are **for reference only**; for evacuation decisions always follow the official announcements of your local authority (the JMA (気象庁) in Japan, NOAA in the United States, and so on). The plugin works only while a DSH page is open.

## Features

- **Real-time push**: a persistent WebSocket connection to P2PQuake; alerts are parsed as soon as they arrive (EEW typically reaches P2PQuake a few hundred milliseconds after the JMA issues it).
- **Automatic reconnection**: exponential backoff (1s → capped at 60s). P2PQuake force-closes connections about every 10 minutes, so reconnecting is normal and needs no intervention. Two silent failure modes are detected and recovered from: a connection that never finishes connecting (no `onopen` within 15 s), and a connection that goes silent after it was established (half-open — no `onclose`, no data for 20 minutes).
- **Disaster types**: earthquake reports (code 551), Earthquake Early Warnings (code 556), and tsunami forecasts (code 552) from P2PQuake, plus **weather alerts from the Japan Meteorological Agency** — landslides (土砂災害警戒情報, 大雨警報（土砂災害）), floods (指定河川洪水予報), heavy rain and storm surges.
- **Watch regions (unified in 0.8.0)**: a **single** entry point — pick a country / region first, then that country's own controls unfold: Japan → prefectures (optionally narrowed to municipalities); Mainland China → province → prefecture-level city + radius; other countries / regions → a **city list** (towns of 100,000+ inhabitants, fetched per country) or coordinates + radius. Watched places are listed together in the same block and can be removed at any time. Leaving the Japanese prefecture list empty means all of Japan.
- **Mainland China earthquakes (0.5.0)**: CENC's **earthquake early warning** (seconds, relayed by Wolfx) and **earthquake reports** (minute-level confirmation and backfill). The Chinese sources carry no regional intensity, so matching is by epicenter plus radius: just pick your city in the settings — no coordinates needed. The report threshold is a separate knob (M4.5 by default) so M2.5 tremors do not flood you.
- **Mainland China weather hazards (0.5.2)**: **heavy-rain** and **geological-disaster** warning signals aggregated by the China Meteorological Administration's National Meteorological Center (issued by weather offices at every level, down to the county). Only **orange and above** is announced; yellow and blue go to the history only. Matching is by administrative area — the province / prefecture-level city you picked — so no radius is involved. An expired warning simply disappears from the list: **the source carries no "cleared" flag**, so "no cancellation received" does not mean "the alert is still in force".
- **Radius in semantic steps**: local only (~30 km) / city and surroundings (~100 km, the default for new watch points) / wider area (~300 km), or type an exact number of kilometres.
- **Overseas weather alerts (0.6.0)**: flood / flash-flood / coastal-flood warnings from the US **NWS**, and rainfall / flood / storm-surge warnings from Canada's **ECCC**. Both are fetched **directly by the browser** from the official APIs (no Host relay) using the coordinates you set under "Other countries / regions": the NWS source judges by the county / zone the point falls in (with a radius ≥ 25 km it also samples four compass points, so the radius is an **approximation**), while the ECCC source converts your radius into a bounding box and asks ECCC for every warning overlapping it. Only **Warning**-class NWS events are announced (Flood / Flash Flood / Coastal Flood Warning); Watch, Advisory and Statement go to history only. ECCC contributes **warning**-class rainfall / flood / storm-surge alerts only — frost and fog are advisories (ECCC's own definition of "generally not considered hazardous"), while wind, heat and thunderstorms *are* warnings but fall outside this plugin's hazard scope. A warning published more than 6 hours before you open the page is recorded in history without ringing.
- **Global earthquakes and tsunamis (0.4.0)**: EMSC's live WebSocket push plus USGS's global earthquake catalog (polled by the Host half) cover earthquakes worldwide; NOAA's tsunami CAP messages cover the Pacific and other basins.
- **Only once per earthquake (0.8.0)**: the Japanese network, China's network, EMSC and USGS can each report the same earthquake on their own. Now **only the first source to arrive announces it**, and the remaining copies do not even enter the history (the test is ±2 minutes + 50 km + **across agencies**); the number of suppressed copies is counted in the diagnostic snapshot rather than vanishing silently. Two product lines inside the same agency (mainland China's warning → report) still follow the existing history-only path — "the network's final determination was M3.2" is useful information in its own right.
- **Global watch points**: under the "other countries / regions" branch, pick cities by country (**towns of 100,000+ inhabitants**), or enter coordinates yourself / use browser geolocation; each point carries a radius (up to 20). An alert fires when the epicenter falls inside the radius and the magnitude reaches the global threshold (M4.5 by default, adjustable). Japanese earthquakes and tsunamis are unaffected by this and are still judged by prefecture; with no watch point configured, global and Chinese messages neither alert you nor enter the history.
- **Disaster types and thresholds in one table (0.8.0)**: one hazard per row, with the switch on the left deciding whether to alert and the threshold on the right deciding how strong it has to be — earthquakes by observed intensity, EEW by predicted intensity, tsunamis by grade (advisory / warning / major warning), global and mainland-China earthquakes by magnitude, mainland reports on a threshold of their own. Weather hazards have fixed boundaries (L4 in Japan, orange in mainland China, warning overseas), so they get a switch and nothing else.
- **Notifications**: synthesized alert tones (Web Audio; earthquake / EEW / tsunami / weather / cancellation each have their own tone) with adjustable volume; in-page toast when the page is visible, system notification when it is in the background. Earthquake and EEW headlines carry the intensity (observed or predicted), so the alert itself tells you how strong it is.
- **Cancellation notices**: if an EEW you were alerted about is cancelled, or a tsunami forecast you were alerted about is cleared, a short follow-up (descending tone) tells you the earlier alert is void. A cancellation for an event you were never alerted about stays silent (history only). US NWS flood alerts carry a real `Cancel` semantic too — the event key is NWS's own VTEC tracking number `<office>.<phenom>.<sig>.<ETN>`, and a cancellation only changes its ACTION segment to `CAN`, so it is matched to the warning it withdraws and gets the same "no longer valid" reminder. ECCC's `status_en` has no verified meaning (a freshly issued frost advisory is also `ended`), so it is never treated as a cancellation; the two mainland-China feeds have no such field either (see the known limitations below).
- **Quiet hours**: silence non-critical alerts during a daily window (local browser time; a start later than the end crosses midnight). Red-level alerts — EEW, tsunami warnings (Warning and above), intensity 6-lower-or-above earthquakes, and level-4+ weather alerts — still break through unless you turn that off. Suppressed alerts stay in the history.
- **Weather alerts, level 4 and above**: the JMA states an explicit warning level on every weather telegram. Only level 4+ — the "evacuation instruction" grade — is announced; levels 1–3 are still fetched, parsed and listed in the history, and a level-3 hit merely adds one line to the sidebar tooltip. See [Warning levels](#warning-levels-japan).
- **Connection indicator**: a status dot at the sidebar foot — green connected, amber connecting/reconnecting/degraded, mid-grey data stale, blue data-format error (wait for a plugin update), red stopped or unreachable, hollow grey disabled by you — with per-source details on hover. Settings → **Test & diagnostics** → Source status additionally lists increments, failures, gaps, last poll and upstream staleness (0.4.1).
- **Machine-level persistence**: configuration goes to DSH's machine-level storage (the Host settings `settings.yaml` up to DSH 0.1.6; the plugin entry's profile configuration from 0.1.7 on), so it survives across browsers and machines. A browser `localStorage` copy stays as a mirror, and as the fallback when that storage is unavailable; existing local settings migrate once, on first run.
- **Municipality-level watch**: narrow earthquake reports down to individual cities / wards / towns / villages, chosen from a searchable per-prefecture list (1,917 entries). Observed-intensity point names are resolved to their municipality first, so the many official spellings all match (大阪北区茶屋町 → 大阪市北区, 福島伊達市 → 伊達市, 渡島北斗市 → 北斗市). Only observed-intensity points carry that granularity; EEW and tsunami stay prefecture-level, and a point that cannot be resolved is treated as a match rather than dropped.
- **Data source switch**: production (live) or sandbox (replays 2023 history, roughly one message every 30 seconds, for testing).
- **Smart de-duplication**: multiple releases for the same earthquake (intensity prompt → detailed intensity report, or successive EEW updates) notify you only once, and again only when the intensity is upgraded; when **several sources report the same earthquake** only the one that arrives first announces it (0.8.0). With several DSH pages open, only one tab plays the alert.
- **History**: the most recent 30 processed messages, including entries that did not reach the threshold; click an entry to expand its details.
- **Interface language (0.9.0)**: 简体中文 / 日本語 / English, switched in Settings → More → Language, and it takes effect **immediately** (no restart). Only the text **this plugin writes itself** is translated — setting labels, notification titles, action prompts, disclaimers, hit lines and history badges. Everything that comes from a source stays verbatim: headlines, descriptions, place names, the weather agency's own category names. An alert about a Japanese earthquake therefore reads as an English (or Chinese) template wrapped around Japanese place names — that is by design, not a gap.
- **Settings export and import (0.9.0)**: write your configuration (watch regions, thresholds, language, data source, quiet hours, notification switches) to a JSON file and load it on another machine or browser. The file carries a **format version and no plugin version**; a file whose format is newer than this build can read is **refused outright** rather than half-parsed. Importing **replaces** the whole configuration, and the previous one is backed up automatically first, so "Undo last import" is always available. Alert history and source health are **not** part of the file.

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

- All realtime logic runs in the browser (the Client half): the WebSocket connections, parsing, matching, notifications and the history list. The Host half wires the `quake-alert` configuration into the host's settings service (from 0.1.7 the form is derived from the exported `Config` schema; up to 0.1.6 the plugin registered the namespace itself), serves the read-only municipality table, river-forecast-area table, Chinese administrative-division table and country / region list at `/dsh-quake-alert/areas` (**the cities themselves are fetched separately, in per-country chunks, with `?country=XX`** — see 0.8.0), and polls the feed for each of the three polled sources.
- **Two realtime links, both Client-direct**: P2PQuake (Japan, sub-second) and EMSC (global). Global earthquake traffic is far sparser than Japan's — an M4+ event arrives roughly every 30 minutes on average — so the EMSC connection **deliberately uses a long three-hour "no data" threshold** instead of a tight one: M4+ events are sparse enough that a short window would keep tearing down a perfectly healthy connection. Real disconnects are still caught by `onclose` and the connect watchdog.
- **Three polled sources, one external requester (the Host half)**: the JMA Atom feed (landslides / floods / heavy rain / storm surges, about once a minute), the USGS GeoJSON catalog (global earthquakes, every 2 minutes) and the NOAA event list plus CAP messages (tsunamis, every 5 minutes). The Host remembers which entries it has already fetched and exposes the increment on a local read-only route, `/dsh-quake-alert/feed?source=jma|usgs|noaa&since=N`; the Client polls that route every 15 s and hands each message to the very same `handleAlert` used by P2PQuake messages. Keeping the only external requester on the Host means several DSH tabs or windows never multiply the requests — the JMA explicitly asks consumers not to re-download a file it has already served, and blocks IPs that do. The Client persists a cursor per source, so a refresh resumes where it left off instead of replaying the buffer; a first run (no cursor yet) uses `?since=tail` to align to the current position without replaying anything.
- **Two overseas sources, fetched directly by the Client (0.6.0)**: the US NWS and Canada's ECCC are queried straight from the browser rather than through the Host half. The reason is that they are **only usable as per-watch-point queries** (NWS `?point=lat,lon`, ECCC `bbox=`), while pulling everything would mean 1.2 GB/day and 144 MB/day respectively; the Host's standing rule is that it does not know the Client's configuration, so it has no watch points — going through the Host would force full pulls and effectively mean dropping both sources. Both APIs return `Access-Control-Allow-Origin: *` (measured), so the browser can call them directly. The two are deliberately not unified: NWS `?point=` returns the warnings for the county / zone containing the point and does not expand to a radius, so radii ≥ 25 km add four compass samples (an approximation); ECCC's `bbox` takes the radius directly. Requests are serial, with a 10 s timeout and a 512 KB body cap; **no watch point in that country means no request at all**.
- **Two watch modes coexist**: Japanese sources are judged by prefecture (optionally narrowed to municipalities); global sources carry only an epicenter, so they are judged by spherical distance (Haversine) against your watch points and their radius. Magnitude and JMA intensity are not convertible into one another, which is why global sources get a threshold knob of their own (M4.5 by default). The settings page unifies them into **one user path** (pick a country / region first), but there are still two data models underneath — forcing Japan onto coordinate matching would miss earthquakes whose epicenter is somewhere else while your own area still reaches intensity 5-lower.
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
2. **Watch regions**: pick a **country / region** first (Japan / Mainland China / other countries / regions), then work through that country's own controls:
   - **Japan**: select the prefectures you live in or care about (leave empty for all of Japan). Once a prefecture is selected you can narrow it further to municipalities (searchable, multi-select).
   - **Mainland China**: pick a province → a city → a radius → "Add this city". Alternatively click "Use my location" to add a watch point straight from browser geolocation (it warns you that the fix may be imprecise). Coordinates in the table are **administrative centres** — for very large prefectures (Garzê, Harbin) the point can be over 100 km from the urban centre, so widen the radius if you live on the edge.
   - **Other countries / regions**: pick a country → find a city in the search box → **one click adds it** (it uses the shared radius steps). The city table only contains **towns of 100,000+ inhabitants**; for a country / region missing from the table, or for an exact point, fill in the coordinate form below by hand (or use "Use current location").
   - Watched places are **listed together** below this block (grouped by origin: Japan / Mainland China / other countries) and can be removed at any time.
3. **Disaster types and thresholds**: one hazard per row — the switch decides whether to alert, the threshold decides how strong it has to be. Weather hazards have fixed boundaries, so they get a switch and no steps.
4. **Notifications and sound**: enable the alert tone and/or system notifications and adjust the volume. Use the preview buttons to check the tones, and "Test system notification" to grant permission and verify delivery.
5. **Data source**: keep "Production" for daily use; switch to "Sandbox" to verify the pipeline or see it in action (about one 2023 replay every 30 seconds).
6. **Test & diagnostics**: two test buttons (weather / global) build **telegrams in the source format** locally and run them through the real parsers and matcher, making **no network request at all**, so you can click them as often as you like — the way to confirm the pipeline works on a day with no real disaster (the result line reports honestly whether anything was announced, and why not when it was not). Below them are the per-source status and the diagnostic snapshot (ready to paste into an AI assistant for troubleshooting).
   - **"Send test global alert (rotating scenarios)"** builds EMSC / USGS / NOAA telegrams. Four scenarios rotate; the "distant earthquake" one is ~550 km away (it misses when your radius is smaller than that and hits when it is larger), to show what the radius does.
   - **"Send test weather alert (rotating scenarios)"** rotates through landslide / flood / heavy rain / storm surge, plus an L3 case that deliberately stays silent.
   - **"Global source status"** shows the EMSC connection plus how many increments each polled source (JMA / USGS / NOAA) has received and how long ago it last polled — so you can confirm the pipeline is alive. Worldwide earthquakes are infrequent by nature; hearing nothing is the normal state.

When an alert matches, you get a tone plus a foreground toast or a background system notification, and the event is recorded in "Recent alerts".

## A source is unreachable? (mainland-China networks)

Under mainland-China networks a data source may become unreachable, stop updating, or alerts may stay
silent. Those failures only reproduce there — this project's dev machine exits from Japan — so the
approach is to make every failure **visible** and ship a troubleshooting document written **for an AI
assistant** (Chinese only, since mainland users are its only audience):

> **Hand [`TROUBLESHOOTING.zh.md`](./TROUBLESHOOTING.zh.md) to your AI assistant and let it work
> through it step by step.**

That document explains no theory and asks nobody to "open a menu and look": every section is
"trigger → command you can actually run / state you can actually read → what the result means".
The AI cannot fix the network; its job is to **classify** the failure, **state the blast radius**
(which links still work), and pick a downgrade path where one exists — and to say plainly when the
conclusion is "not something you can fix".

For day-to-day self-checks you do not need the document: **Settings → Disaster alerts → Test & diagnostics → Source status**
lists each source's state, how many increments arrived, failure counts, gap counts and the time of the
last poll; hovering the sidebar status dot shows the same (abnormal sources first).

## Behaviour changes in 0.4.1

- **Region filtering is stricter about unresolvable areas (adjusted in 0.4.2).** When a message
  contains at least one area that resolves to a prefecture, areas that cannot be resolved no longer
  take part in prefecture filtering (one unknown forecast-area name no longer alerts every user);
  only when *every* area is unresolvable does it pass (prefer over-alerting over going silent).

- **Weather events are merged per (forecast office, hazard) with a 3-hour event window.** Updates,
  area extensions and continuations of the same hazard from the same office alert once; an intensity
  escalation (L3→L4) still alerts again. Crossing an hour boundary, or the same event issued by two
  offices, may still alert twice — we prefer one extra chime over a missed alert.
- **The L4 gate now looks at the level of the region that matched**, not the telegram maximum. In one
  real telegram (Hyogo, 2026-09-14) Himeji is L4 while Aioi is L3 and Nishiwaki is L2; watching only
  Nishiwaki no longer produces an overstated "evacuation-level" alert.
- **A tsunami cancellation only matches when the telegram lists the forecast areas.** A cancellation
  without a list is recorded in history but does not notify — that avoids "some other sea area's
  cancellation is presented as your event" (a false all-clear is the worst kind of wrong for tsunamis).
- **Global earthquakes are graded by magnitude** (EMSC/USGS have no intensity scale), so the red-level
  quiet-hours bypass applies to M7+ global quakes too.
- **"Source is responding but data is old" is a separate state** (mid-grey): JMA's feed update time or
  USGS's feed generation time beyond the threshold shows as upstream staleness, distinct from
  "no news". A data-format problem is shown in blue — that is not the user's network to fix.
- **P2PQuake timestamps are converted from JST to your local time zone** in history details (previously
  the raw JST string was shown, an hour off with no label for mainland-China users).

## Known limitations

- The plugin runs with the DSH page: closing the page stops it, and browsers may throttle background tabs, delaying notifications.
- Cancellation / clearance notices only fire for events that were previously alerted; a cancellation for an event you never saw stays in the history and does not interrupt you.
- Tsunami forecasts (552) carry no mergeable event id, so successive releases of the same tsunami (added areas, upgraded grade) each notify.
- With several DSH pages open, each page keeps **two** WebSocket connections of its own (P2PQuake and EMSC). Alerts are de-duplicated via BroadcastChannel, but the number of connections grows with the number of tabs — and P2PQuake enforces a concurrency limit, so opening a great many tabs deserves a thought.
- Several DSH pages **share the same per-source cursors**: a telegram or earthquake already handled by one page is not replayed in another (cross-tab de-duplication only ever lets one page announce it). The trade-off is that a page opened or reloaded later does not add those already-consumed entries to its own "Recent alerts" list.
- Hypocenter-only reports (551 "hypocenter information" / "distant earthquake") carry no intensity data and cannot be evaluated against thresholds; they are recorded in "Recent alerts" with an explanatory note.
- System notification permission must be granted once via "Test system notification"; the alert tone requires one user interaction before the browser allows it (autoplay policy).
- **Coverage**: Japanese earthquakes / EEW / tsunamis come from P2PQuake over a WebSocket, and weather alerts from the JMA's Atom feed (polled by the Host half about once a minute). Outside Japan, coverage comes from EMSC (live push), USGS (global catalog, polled by the Host every 2 minutes) and NOAA (tsunami CAP, polled every 5 minutes). Earthquakes in **mainland China** come from Wolfx relaying CENC (the China Earthquake Networks Center): the Host half holds one persistent connection per source and streams it to the page over SSE. Weather warnings for mainland China come separately from nmc.cn's warning-signal list (polled by the Host half every 120 seconds) and cover the heavy-rain and geological-disaster categories only. US and Canadian weather alerts (0.6.0) are fetched **directly by the browser** from the NWS and ECCC APIs, using the watch points configured under "Other countries / regions". Other regional weather sources (Europe's MeteoAlarm, GDACS) were evaluated and left out — their granularity, hazard set or coordinate support did not qualify (see DESIGN 4.6).
- **Five boundaries of the overseas weather sources (0.6.0; ④⑤ added in 0.6.1)**: ① the US radius is an **approximation** — NWS judges by county / zone and the radius only adds four samples, so coverage of every county inside the radius is not guaranteed; ② **ECCC does not cover river floods** — river-flood warnings in Canada are issued by provincial agencies (such as the BC River Forecast Centre) with no national API, while ECCC issues weather warnings and coastal storm-surge warnings; "the plugin is installed" must not be read as "somebody is watching Canada's floods"; ③ **neither source can detect an upstream stall** — a per-point / per-box query is legitimately empty, so "no data this round" and "the upstream stopped" look identical; only request failures and schema drift are observable. Note also that the NWS is key-free today but has said its User-Agent string will become an API key — at that point direct browser calls stop working and the Host half would have to be brought back in.
  (added in 0.6.1) ④ **ECCC has no reliable "ended" signal** — its `status_en` does contain `ended` / `continued`, but a freshly issued frost advisory is also `ended`, so the meaning is unverified and ECCC's `cancelled` is **always false**: an expired ECCC warning never produces a follow-up saying it is void (better to say one word too many than to pretend we can handle it). NWS does have a real CAP `Cancel`, and that cancellation path works. ⑤ **ECCC's hazard whitelist is the only part of this design not backed by measurements** — its code table has no official enumeration and there are no rainfall samples in the current season, so the whitelist is built from English-name keywords and needs calibration once real rainfall warnings arrive. Mind the age rule too: alerts already issued more than 6 hours ago when you **open the page** are recorded without ringing, and a page that has been **asleep for over 30 minutes** is treated the same way on wake.
- **Global sources are coarser than Japanese ones**: they carry only an epicenter and a magnitude, with nothing down to the municipality; tsunamis are expressed as NOAA sea areas (such as `SCOTIA SEA`) rather than Japan's 津波予報区; and landslides / floods outside Japan have no ingestion channel yet.
- **The same earthquake may still be reported once by each source (narrowed in 0.8.0, but not eliminated)**: the cross-source merge window is ±2 minutes + 50 km + across agencies, so when two determinations fall outside it in time or epicenter (EMSC's and USGS's origin times cross a minute boundary, or their epicenters differ by more than 50 km) each still reports once. Suppressed copies **do not enter the history**, but they are counted in the `authority` section of the diagnostic snapshot. The trade-off matches the rest of the project: better one chime too many than a missed alert.
- **The global city table only contains towns of 100,000+ inhabitants (0.8.0)**: small towns and villages are not in it, so use the coordinate form or "Use current location" when you need one. Cities with the same name inside one country get their first-level administrative area appended to the name ("Springfield (Illinois)"), and that area name is **in English** (GeoNames only provides Latin-script names) — it only affects how readable the list is and takes no part in matching.
- **The Chinese sources carry no cancellation or final-report flag (safety-relevant)**: neither CENC stream has a "cancelled" or "final" field, so **if an alert already announced to you is later withdrawn or revised upstream, the plugin cannot send a follow-up saying it is void** — the cancellation path that exists for Japanese EEW / tsunamis does not apply here. That is a gap in the source itself, not something an implementation can paper over. For anything you receive, defer to CENC's own official release.
- **The mainland weather source has no "cleared" flag either, and orange alerts do not pierce quiet hours**: nmc.cn's warnings are a "currently in force" set — an expired warning simply vanishes from the list, so the plugin never sees a "cleared" action and will not post a follow-up saying a heavy-rain / geological-disaster alert it announced is void. Orange is also mapped faithfully to the official level (orange ≠ red) while quiet hours release red only by default, so an orange warning issued at night leaves a trace in "Recent alerts" and nothing more.
- **Mainland China's EEW threshold sits around M4.0**: the warnings themselves are sparse (a few days apart in practice), so you will receive noticeably fewer alerts than for Japan. The reports stream (which does have data daily) has its own magnitude threshold, M4.5 by default and adjustable in the settings.
- **The Chinese push channel can be downgraded**: the page uses an SSE long connection (seconds of latency); if a network middlebox cuts it (EventSource unavailable, no first frame after repeated attempts, or connected but not streaming), the plugin automatically falls back to 15-second polling and says so under "Source status" in the settings. You can also force polling there.
- **CENC's warning and report streams are independent**: if both cover the same earthquake they are merged by origin time (minute) plus epicentre (0.1°) so you are alerted once — that is **inside one agency**, and it runs down the "no intensity upgrade → history only" path, so 0.8.0's cross-source suppression does not apply to it; if they fall on opposite sides of a minute boundary, or the epicentres differ by more than 0.1°, the merge fails and the same earthquake may alert twice. Same trade-off as the global sources: better twice than never.
- **The EMSC connection uses a long three-hour "no data" threshold**: an M4+ event arrives roughly every 30 minutes worldwide, so a tight window would keep tearing down a healthy connection. Real disconnects are still detected and reconnected.
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
client/src/*.js       # client sources: 27 standard ESM modules (explicit import/export; each header states job + deps)
client/client.js      # DSH single-file bundle — GENERATED by rollup, do not edit
lib/index.js          # Host half: settings namespace (schemastery) + the /areas and /feed read-only routes
lib/poller.js         # Host half: generic feed poller (entry de-duplication, ring buffer, cursor; single-stage and two-stage sources)
lib/global-sources.js # Host half: USGS / NOAA feed parsers and endpoints (the JMA parser is still the poller default)
lib/data/cities.js    # municipality table (generated from public data; served to the browser half)
lib/data/cn-areas.js  # Chinese administrative divisions (provinces → prefecture-level cities + coordinates, GENERATED by build-cn-areas.mjs)
lib/data/world-cities.js  # global city table (166 countries / 5224 cities, served per country, GENERATED by build-world-cities.mjs)
lib/data/river-areas.js   # river forecast areas → municipalities (GENERATED by build-areas.mjs)
scripts/build-client.mjs  # bundles client/src into client/client.js with rollup
scripts/build-areas.mjs   # regenerates lib/data/river-areas.js from the JMA public zip
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
node scripts/build-world-cities.mjs    # regenerate the global city table from the GeoNames dump (needs network)
node scripts/check-imports.mjs         # cross-module reference check (missing import / undeclared assignment)
node scripts/build-client.mjs --check  # fail when the committed bundle is stale
node tests/sync-test.cjs               # regression tests (1427 assertions)
node scripts/check-contracts.mjs       # contract check: pull the live sources through the parsers to catch upstream changes (--offline uses samples/, no network)
```

> **Note**: `tests/sync-test.cjs` loads the **built** `client/client.js`. After editing `client/src/`
> always run `node scripts/build-client.mjs` first, otherwise you are looking at the previous build.
> One-liner: `node scripts/build-client.mjs && node tests/sync-test.cjs`.
>
> On Windows, if `pnpm` fails with "cannot be loaded because running scripts is disabled", use
> `pnpm.cmd check` / `pnpm.cmd test` (or `npx pnpm check`). `pnpm check` only verifies the bundle is
> current; `pnpm test` rebuilds and then runs the regression suite.

> Edit `client/src/*.js`, never `client/client.js` — DSH requires a single-file client bundle (flat module
> graph: one bundle is one module node, no in-package multi-file imports), so the ESM modules are bundled by
> rollup at build time. This is also how DSH's own plugins ship: build output only, multi-file sources.

> `samples/` and `tests/` ship with the repository (plain-text test assets with no external dependencies and no network access), so the regression tests above run right after cloning. They are not part of the npm package (not listed in `package.json` `files`). `DESIGN.md` is git-ignored internal design notes.

## Changelog

Current version **0.9.0** (**interface language: Chinese / Japanese / English, plus settings export/import**).
The interface ships three complete text sets, switched in Settings → More → Language and applied
immediately (no restart), while everything that comes from a data source stays verbatim. Settings can be
exported to a JSON file and loaded on another machine: importing replaces the whole configuration after
backing up the previous one, so it can always be undone.
**0.8.0** turned the settings page's region picker from three flat blocks (① Japan / ② Mainland China / ③ Other
regions) into a **single "country / region" entry point** that unfolds only that country's own
controls, with every watched place listed together in the same block. "Disaster types" and "Alert
thresholds" likewise became one per-hazard table (one hazard per row, switch and threshold side by side).
Functionally, **the same earthquake is no longer announced once by every source** — only the source that
arrives first announces it, and the rest do not even enter the history, though they are counted in the
diagnostic snapshot (the only trace if that call was wrong). "Other countries / regions" finally has a
city list too (towns of 100,000+ inhabitants, 166 countries / 5224 entries, delivered per country), so
there is no need to type latitude and longitude by hand.
The suite is now at **1552** assertions (1363 before 0.8.0).
See [CHANGELOG.md](./CHANGELOG.md) for the details of each release.

## Data sources

- Earthquake / tsunami messages: [P2PQuake](https://www.p2pquake.net/) (relaying JMA data), over WebSocket.
- Weather alerts (landslides / floods / heavy rain / storm surges): the JMA's [防災情報XML](https://xml.kishou.go.jp/) Atom feed (`extra.xml`, updated every minute), fetched by the Host half. The river forecast area → municipality table (`lib/data/river-areas.js`) is generated from the JMA's 「指定河川洪水予報区域と市区町村に関するCSVファイル」.
- Mainland China weather warnings (heavy rain / geological disasters): the [National Meteorological Center](https://www.nmc.cn/) warning-signal list (`rest/findAlarm`, polled by the Host half every 120 seconds). The issuing body is a weather office at some level, and the detail page body is fetched separately.
- US weather alerts (flood / flash flood / coastal flood): the [National Weather Service](https://api.weather.gov/) `alerts/active` API (key-free, declared open data free to use for any purpose, application identification requested; **called directly by the browser**, queried per watch point with `?point=`).
- Canadian weather alerts (rainfall / flood / storm surge): the [Environment and Climate Change Canada](https://api.weather.gc.ca/) `weather-alerts` collection (key-free; **called directly by the browser**, queried with `bbox`). Used under the ECCC Data Services End-use Licence v2.1.1: **Data Source: Environment and Climate Change Canada**, with alert content and intent left unaltered.
- Global earthquakes: [EMSC](https://www.seismicportal.eu/) (live WebSocket push) and [USGS](https://earthquake.usgs.gov/) (GeoJSON summary, polled by the Host half).
- Global tsunamis: [NOAA / Pacific Tsunami Warning Center](https://www.tsunami.gov/) (CAP 1.2 messages, polled by the Host half).
- Municipality list (`lib/data/cities.js`): compiled from 総務省「都道府県コード及び市区町村コード」(Public Data Utilization Terms, ver. 1.0) plus the designated-city wards of [jp-local-gov](https://github.com/hideo54/jp-local-gov) (MIT). The shipped file is a processed derivative — merged, de-duplicated and grouped by prefecture.
- Global city table (`lib/data/world-cities.js`): processed from [GeoNames](https://www.geonames.org/) (CC BY 4.0) `cities15000` dump and `admin1CodesASCII.txt` (population ≥ 100,000, excluding Japan and China, 166 countries / 5224 cities). The Chinese administrative-division table (`lib/data/cn-areas.js`) comes from the same source.

## License

MIT © XuZhichao
