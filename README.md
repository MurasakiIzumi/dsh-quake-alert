# dsh-quake-alert · QuakeAlert

**English** · [中文](./README.zh.md) · [日本語](./README.ja.md)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/dsh-quake-alert)](https://www.npmjs.com/package/dsh-quake-alert)

QuakeAlert is a disaster-warning plugin for DeepSeek Harness (DSH). While you are working in DSH it keeps
live feeds open for earthquakes, tsunamis and weather hazards in **Japan** and around the **world**, and
the moment an event matches the regions and thresholds you have configured, it plays an alert tone and
puts a notice in front of you. A visible page gets an in-page toast; a page in the background gets a
system notification instead.

⚠️ **Please read this first**: the alert data is provided or relayed by [P2PQuake](https://www.p2pquake.net/),
the Japan Meteorological Agency's public XML telegrams, [EMSC](https://www.seismicportal.eu/),
[USGS](https://earthquake.usgs.gov/) and [NOAA](https://www.tsunami.gov/). None of those is a direct
official push channel, and neither the content nor the delivery quality of Earthquake Early Warnings
(EEW) comes with any guarantee. Treat everything this plugin shows as **reference only**; when it comes
to evacuation, follow what your local authority publishes. The plugin runs only while a DSH page is
open.

## Features

- **Japan, live**: a WebSocket to P2PQuake stays connected and delivers earthquake reports (551), Earthquake Early Warnings (556) and tsunami forecasts (552). EEW normally reaches P2PQuake a few hundred milliseconds after the JMA issues it.
- **Global, live**: a second WebSocket, this one to EMSC, covers earthquakes worldwide.
- **Japanese weather hazards**: landslides, floods, heavy rain and storm surges, read from the JMA's public XML telegrams. Only warning level 4 and above is announced.
- **Mainland China**: CENC earthquake early warnings and rapid reports relayed by Wolfx, plus the heavy-rain and geological-disaster warning signals published on nmc.cn at orange or above.
- **United States and Canada**: the browser queries NWS directly for flood warnings, and ECCC for rainfall, flood and storm-surge warnings.
- **Worldwide earthquakes and tsunamis**: the USGS global catalog and NOAA tsunami CAP messages, both polled by the Host half.
- **Watch regions**: one entry point for all of them. Pick a country or region and the controls underneath change to suit it. Japan gives you prefectures, optionally narrowed to municipalities; mainland China runs province → city plus a radius; anywhere else offers a city list or raw coordinates with a radius.
- **Radius presets**: local only (~30 km), city and surroundings (~100 km, what a new watch point starts with), or wider area (~300 km). You can also type an exact number of kilometres.
- **Thresholds in one table**: one hazard per row. The switch on the left decides whether that hazard alerts at all, the value on the right decides how strong an event has to be. Weather hazards have fixed boundaries, so their rows carry a switch and nothing else.
- **Notifications**: alert tones are synthesized with Web Audio at a volume you set. A page in front gets an in-page toast, a page in the background gets a system notification, and earthquake and EEW headlines carry the intensity.
- **Cancellations**: a short descending tone follows when an EEW you were alerted about is cancelled, or a tsunami forecast is lifted. NWS cancellations are matched through the warning's VTEC tracking number.
- **Quiet hours**: a daily window in which non-critical alerts stay silent. Red-level alerts break through unless you turn that exception off.
- **Reconnection**: backoff widens from 1s up to a 60s ceiling. P2PQuake force-closes connections roughly every 10 minutes, which is normal behaviour; a connection that never opens and one that goes quiet after it opens are both detected and recovered from.
- **One alert per earthquake**: repeated releases about the same earthquake notify once, and again only if the intensity is upgraded. When several agencies report the same event, only the first source to arrive announces it.
- **History**: the last 30 processed messages from the past 5 days. It holds two kinds of entry only, alerts that actually rang and messages the plugin genuinely could not judge.
- **Interface language**: 简体中文 / 繁體中文 / 日本語 / English, switched in the settings and applied immediately. Text arriving from a source is shown verbatim.
- **Export and import**: write the configuration out to a JSON file and load it on another machine or in another browser. Import replaces the whole configuration, and backs up the current one first.
- **Stored on this machine**: configuration lives in DSH's machine-level storage, so it is still there after a browser or machine change. Browser local storage keeps a copy and serves as the fallback whenever the main store is unavailable.
- **Source status**: a dot at the foot of the sidebar shows the current state, and a weather alert that
  has not reached the alert level shows up alongside it. Per-source details — increments received,
  failure counts, gaps, the last poll time, whether an upstream has gone stale — live under
  Settings → Test & diagnostics.
- **Data source switch**: production (live) or sandbox (replays 2023 history, roughly one message every 30 seconds).
- **Local diagnostics**: two test buttons build telegrams in the source format and run them through the real parsers and matcher. No network request is made.

## Installation

```sh
# From npm
dsh plugin --profile web add dsh-quake-alert

# Restart dsh web to activate the plugin
```

To track the repository instead, install it straight from GitHub:
`dsh plugin --profile web add github:MurasakiIzumi/dsh-quake-alert`.

**Updating**: run the command above again and restart `dsh web`. Changes that stay inside the Client
half (`client/`) are live after a page refresh; anything under `lib/` needs the restart.

## Usage

1. Open **Settings → Disaster Alerts** (灾害预警).
2. **Watch regions**. Start with the **country / region**, then work through the controls that appear for it.
   - **Japan**: click the prefectures you care about, or leave them all unselected to watch the whole country. A selected prefecture can be narrowed further to municipalities.
   - **Mainland China**: province → city → radius, then "Add this city". "Use my location" fills in the same form from where you are. Coordinates in the table mark administrative centres, so give very large provinces and cities a wider radius.
   - **Other countries / regions**: choose a country and click a city to add it, or fill in the coordinate form by hand. The city list holds towns of 100,000 inhabitants and up.

   Everything you have added is listed together below this block, and you can remove entries from there at any time.

3. **Disaster types and thresholds**. One hazard per row, with the switch deciding whether to alert and the threshold deciding how strong an event has to be.
4. **Notifications and sound**. Enable the alert tone and system notifications, set the volume, and use the preview buttons to check both.
5. **Data source**. Leave it on "Production" for everyday use, or switch to "Sandbox" when you want to verify the pipeline.
6. **Test & diagnostics**. The two test buttons build telegrams in the source format locally and push them through the real parsers and matcher, so nothing goes over the network and you can click them repeatedly. Below them sit the per-source status and a diagnostic snapshot you can paste into an AI assistant.

A matched alert gives you a tone, an in-page toast while the page is in front or a system notification
while it is not, and a new entry under "Recent alerts".

## A source is unreachable? (mainland-China networks)

On a mainland-China network a data source can become unreachable, stop updating, or alerts can simply
never fire. Those failures reproduce nowhere else, so the plugin turns each one into **visible state**
under **Settings → Disaster alerts → Test & diagnostics → Source status**, and ships a troubleshooting
document written **for an AI assistant** to work through (Chinese only, since mainland users are its
whole audience):

> **Hand [`TROUBLESHOOTING.zh.md`](./TROUBLESHOOTING.zh.md) to your AI assistant and let it follow the
> steps.**

## More documentation

- **[GUIDE.md](./GUIDE.md)** — how it works, coverage and data sources, known limitations, development.
- **[CHANGELOG.md](./CHANGELOG.md)** — what was added, changed, fixed or removed in each version.

## License

MIT © XuZhichao
