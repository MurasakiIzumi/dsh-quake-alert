// Host half · 全球源（0.4.0）
//
// 职责：为「非 JMA」的全球源提供 ①URL 常量 ②feed 解析（把源的原生列表转成 poller 能处理的
// entry 数组）。电文正文的解析仍然在 Client 侧（05c-global-parsers.js）——与 JMA 一样，
// Host 只做「拉取 / 去重 / 缓存 / 游标」，不懂业务。
//
// 两个源的形态差异（都来自实测样本，见 samples/global/）：
//   · USGS：GeoJSON，单级——一次请求就拿到全部字段，没有"详情"可拉。
//     所以 entry 自带 payload，poller 用 singleStage 跳过二次请求。
//   · NOAA：Atom 事件列表，两级——但 entry 的 <id> 是 urn:uuid，**不是**详情地址；
//     详情（CAP 1.2 电文）的 URL 在 <link rel="related" title="CapXML document" href> 里。

/** USGS 的 M2.5+ / 24 小时摘要（GeoJSON）。选它而不是 all_hour：一小时窗口可能一条都没有。 */
export const USGS_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'

/** NOAA 太平洋海啸警报中心（PTWC）的事件列表（Atom）。详情是每个 entry 的 CAP 电文。 */
export const NOAA_FEED_URL = 'https://www.tsunami.gov/events/xml/PHEBAtom.xml'

/** 取 <link> 里指定 title 的 href（属性顺序不固定，所以先解析属性再比对）。 */
function linkHref(entryXml, titleWanted) {
  for (const m of String(entryXml).matchAll(/<link\b([^>]*?)\/?>/g)) {
    const attrs = m[1]
    const href = /href="([^"]*)"/.exec(attrs)
    const title = /title="([^"]*)"/.exec(attrs)
    if (href && title && title[1] === titleWanted) return href[1].trim()
  }
  return ''
}
function tagText(block, name) {
  const m = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>').exec(String(block))
  return m ? m[1].trim() : ''
}

/**
 * USGS GeoJSON → entry[]（单级：entry.payload 就是这条 feature 的 JSON 文本）。
 * @param {string} text GeoJSON 原文
 * @returns {{ id: string, title: string, updated: string, payload: string }[]}
 */
export function parseUsgsEntries(text) {
  let json
  try { json = JSON.parse(String(text)) } catch (err) { return [] }
  const feats = (json && Array.isArray(json.features)) ? json.features : []
  const out = []
  for (const f of feats) {
    const p = (f && f.properties) || {}
    const id = String((f && f.id) || p.code || '')
    if (!id) continue
    // updated（而不是 time）作为"这条何时出现"的判据：USGS 修订同一事件时会刷新 updated，
    // 用 time 会让修订版被当成历史丢掉。
    const ts = (typeof p.updated === 'number' && Number.isFinite(p.updated)) ? p.updated : p.time
    const updated = (typeof ts === 'number' && Number.isFinite(ts)) ? new Date(ts).toISOString() : ''
    out.push({
      id,
      title: String(p.title || p.place || ''),
      updated,
      payload: JSON.stringify(f),
    })
  }
  return out
}

/**
 * NOAA 事件列表（Atom）→ entry[]（两级：entry.detailUrl 指向 CAP 电文）。
 * entry 的 id 用 urn:uuid，它在同一事件修订时会变化，因此另外拼一个以 CAP 路径为基准的
 * 去重键——路径里带事件号与版本（…/26234000/1/WEPA42/PHEBCAP.xml），修订即换 URL，
 * 正好符合"拉过的 URL 永不重拉"。
 * @param {string} text Atom 原文
 * @returns {{ id: string, title: string, updated: string, detailUrl: string }[]}
 */
export function parseNoaaEntries(text) {
  const blocks = String(text).match(/<entry>[\s\S]*?<\/entry>/g) || []
  const out = []
  for (const b of blocks) {
    const detailUrl = linkHref(b, 'CapXML document')
    if (!detailUrl) continue // 没有 CAP 的条目（纯公告）没有可解析的电文，跳过
    const uuid = tagText(b, 'id')
    out.push({
      id: detailUrl || uuid,
      title: tagText(b, 'title'),
      updated: tagText(b, 'updated'),
      detailUrl,
    })
  }
  return out
}
