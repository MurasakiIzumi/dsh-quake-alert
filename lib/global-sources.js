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
 * 取 USGS feed 的生成时刻（`metadata.generated`，epoch 毫秒）。
 *
 * 用途是**上游停更检测**（0.4.1 的 fresh 判据）：USGS 摘要 feed 每 5 分钟重新生成，
 * 若这个时刻距现在超过 30 分钟，说明上游停更、或我们拿到的是某层缓存——
 * 那是"链路在跑但数据是旧的"，与"没有地震"完全不同，必须能被看见。
 * @returns {number} epoch 毫秒；拿不到时返回 NaN（调用方按"未知"处理，不误判为 stale）
 */
export function usgsFeedGeneratedAt(text) {
  try {
    const json = JSON.parse(String(text))
    const g = json && json.metadata && json.metadata.generated
    return (typeof g === 'number' && Number.isFinite(g)) ? g : NaN
  } catch (err) { return NaN }
}

/**
 * USGS GeoJSON → entry[]（单级：entry.payload 就是这条 feature 的 JSON 文本）。
 * @param {string} text GeoJSON 原文
 * @returns {{ id: string, title: string, updated: string, payload: string }[]}
 */
export function parseUsgsEntries(text) {
  let json
  try {
    json = JSON.parse(String(text))
  } catch (err) {
    // **抛错而不是返回空数组**（0.4.1）：JSON 解析失败（被拦截成 HTML、上游改版、响应被截断）
    // 与"这个窗口没有地震"是完全不同的两件事，返回 [] 会让两者在 /feed?stats=1 上同形——
    // 用户看到的是"源正常、只是没有新消息"。抛错由 poller 计入 errors 并落日志。
    throw new Error('USGS feed 不是合法 JSON（可能是拦截页或上游改版）：' + String((err && err.message) || err))
  }
  const feats = (json && Array.isArray(json.features)) ? json.features : []
  if (!json || !Array.isArray(json.features)) {
    throw new Error('USGS feed 缺少 features 数组（结构不符）')
  }
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
