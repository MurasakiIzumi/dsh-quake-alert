# dsh-quake-alert · QuakeAlert

**English** · [中文](./README.zh.md) · [日本語](./README.ja.md)

A DeepSeek Harness (DSH) plugin that alerts you in real time to **Japanese** and **global** earthquakes,
tsunamis and weather hazards, matched against the regions and thresholds you configured. A matching
alert gives you an alert tone, an in-page toast and a system notification.

⚠️ **Disclaimer — please read first**: alert data is provided or relayed by
[P2PQuake](https://www.p2pquake.net/), the Japan Meteorological Agency's public XML feed,
[EMSC](https://www.seismicportal.eu/), [USGS](https://earthquake.usgs.gov/) and
[NOAA](https://www.tsunami.gov/) — none of them a direct official push channel, and the content and
delivery quality of Earthquake Early Warnings (EEW) are not guaranteed. Alerts from this plugin are
**for reference only**; for evacuation decisions always follow the official announcements of your local
authority. The plugin works only while a DSH page is open.

## Features

- **Realtime push, Japan**: a persistent WebSocket to P2PQuake for earthquake reports (551), Earthquake Early Warnings (556) and tsunami forecasts (552). EEW reaches P2PQuake a few hundred milliseconds after the JMA issues it.
- **Realtime push, global**: an EMSC WebSocket for worldwide earthquakes.
- **Japanese weather alerts**: landslides, floods, heavy rain and storm surges from the JMA's public XML telegrams, announced at warning level 4 and above.
- **Mainland China**: CENC earthquake early warnings and reports relayed by Wolfx, plus heavy-rain and geological-disaster warning signals from nmc.cn (orange and above).
- **United States and Canada**: NWS flood warnings and ECCC rainfall / flood / storm-surge warnings, fetched directly by the browser from the official APIs.
- **Global earthquakes and tsunamis**: the USGS catalog and NOAA tsunami CAP messages, both polled by the Host half.
- **Watch regions**: one entry point — pick a country / region, then that country's own controls. Japan → prefectures, optionally narrowed to municipalities; mainland China → province → city + radius; other countries / regions → a city list or coordinates + radius.
- **Radius in semantic steps**: local only (~30 km) / city and surroundings (~100 km, the default for new watch points) / wider area (~300 km), or type an exact number of kilometres.
- **Thresholds in one table**: one hazard per row, with the switch on the left deciding whether to alert and the threshold on the right deciding how strong it has to be. Weather hazards have fixed boundaries, so they get a switch and nothing else.
- **Notifications**: synthesized alert tones with adjustable volume, an in-page toast while the page is visible and a system notification while it is in the background. Earthquake and EEW headlines carry the intensity.
- **Cancellation notices**: a short follow-up tone when an EEW you were alerted about is cancelled or a tsunami forecast is cleared. NWS cancellations are matched through the warning's VTEC tracking number.
- **Quiet hours**: silence non-critical alerts during a daily window. Red-level alerts break through unless you turn that off.
- **Reconnection**: exponential backoff (1s → 60s). P2PQuake force-closes connections about every 10 minutes, so reconnecting is normal; a connection that never opens and a connection that goes silent afterwards are both detected and recovered from.
- **Only once per earthquake**: multiple releases of the same earthquake notify once, and again only when the intensity is upgraded. When several agencies report the same earthquake, only the first source to arrive announces it.
- **History**: the most recent 30 processed messages from the past 5 days, keeping only the alerts that actually rang and the ones the plugin genuinely could not judge.
- **Interface language**: 简体中文 / 繁體中文 / 日本語 / English, switched in the settings and applied immediately. Text that comes from a source stays verbatim.
- **Settings export and import**: write your configuration to a JSON file and load it on another machine or browser. Import replaces the whole configuration and backs up the previous one first.
- **Saved on this machine**: configuration is stored through DSH, so it survives across browsers and machines, with a browser copy as a mirror and fallback.
- **Source status**: a status dot at the sidebar foot with per-source details on hover, plus increments, failures, gaps, last poll and upstream staleness under Settings → Test & diagnostics.
- **Data source switch**: production (live) or sandbox (replays 2023 history, roughly one message every 30 seconds).
- **Local diagnostics**: two test buttons build telegrams in the source format and run them through the real parsers and matcher, making no network request at all.

## Installation

```sh
# Straight from GitHub
dsh plugin --profile web add github:MurasakiIzumi/dsh-quake-alert

# Restart dsh web to activate the plugin
```

**Updating**: replace the package contents, then restart `dsh web`. Changes confined to the Client half
(`client/`) take effect after a page refresh; anything under `lib/` needs the restart.

## Usage

1. Open **Settings → Disaster Alerts** (灾害预警).
2. **Watch regions** — pick a **country / region** first, then work through that country's own controls:
   - **Japan**: select the prefectures you care about (leave empty for all of Japan); a selected prefecture can be narrowed to municipalities.
   - **Mainland China**: pick a province → a city → a radius → "Add this city", or use "Use my location". The coordinates in the table are administrative centres, so widen the radius for very large prefectures.
   - **Other countries / regions**: pick a country, find a city and add it in one click, or fill in the coordinate form by hand. The city list holds towns of 100,000+ inhabitants.

   Watched places are listed together below this block and can be removed at any time.
3. **Disaster types and thresholds** — one hazard per row: the switch decides whether to alert, the threshold decides how strong it has to be.
4. **Notifications and sound** — enable the alert tone and/or system notifications, adjust the volume, and use the preview buttons to check them.
5. **Data source** — keep "Production" for daily use, or switch to "Sandbox" to verify the pipeline.
6. **Test & diagnostics** — the two test buttons build telegrams in the source format locally and run them through the real parsers and matcher, making no network request, so you can click them as often as you like. Below them are the per-source status and a diagnostic snapshot you can paste into an AI assistant.

When an alert matches, you get a tone plus a foreground toast or a background system notification, and
the event is recorded in "Recent alerts".

## A source is unreachable? (mainland-China networks)

Under mainland-China networks a data source may become unreachable, stop updating, or alerts may stay
silent. Those failures only reproduce there, so the plugin makes every failure **visible** under
**Settings → Disaster alerts → Test & diagnostics → Source status**, and ships a troubleshooting
document written **for an AI assistant** (Chinese only, since mainland users are its only audience):

> **Hand [`TROUBLESHOOTING.zh.md`](./TROUBLESHOOTING.zh.md) to your AI assistant and let it work
> through it step by step.**

## More documentation

- **[GUIDE.md](./GUIDE.md)** — how it works, coverage and data sources, known limitations, development.
- **[CHANGELOG.md](./CHANGELOG.md)** — what was added, changed, fixed or removed in each version.

## License

MIT © XuZhichao
