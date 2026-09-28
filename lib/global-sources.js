// Host half · 全球源（USGS / NOAA）：提供 URL 常量与 feed 解析（源的原生列表 → poller 的 entry 数组）。
// 电文正文的解析在 Client 侧（05c-global-parsers.js），Host 只做拉取 / 去重 / 缓存 / 读取位置。
// USGS 是 GeoJSON 单级（entry 自带 payload，poller 用 singleStage 跳过二次请求）；NOAA 是 Atom 两级，
// entry 的 <id> 是 urn:uuid 而非详情地址，CAP 详情 URL 在 <link rel="related" title="CapXML document">。

/** USGS 的 M2.5+ / 24 小时摘要（GeoJSON）。 */
export const USGS_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'

/** NOAA 太平洋海啸警报中心（PTWC）的事件列表（Atom）；详情是每个 entry 的 CAP 电文。 */
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

/** 取 USGS feed 的生成时刻（`metadata.generated`，epoch 毫秒）用于上游停更检测；feed 每 5 分钟重生成，拿不到返回 NaN（按"未知"处理）。 */
export function usgsFeedGeneratedAt(text) {
  try {
    const json = JSON.parse(String(text))
    const g = json && json.metadata && json.metadata.generated
    return (typeof g === 'number' && Number.isFinite(g)) ? g : NaN
  } catch (err) { return NaN }
}

/** USGS GeoJSON → entry[]（单级：entry.payload 就是这条 feature 的 JSON 文本）。
 * @returns {{ id: string, title: string, updated: string, payload: string }[]} */
export function parseUsgsEntries(text) {
  let json
  try {
    json = JSON.parse(String(text))
  } catch (err) {
    // **抛错而不是返回空数组**：解析失败与"这个窗口没有地震"是两件事，返回 [] 会让两者同形。
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
    // updated（而不是 time）作为"这条何时出现"的判据：USGS 修订同一事件时会刷新 updated。
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
 * 去重键用以 CAP 路径为基准的 detailUrl：路径里带事件号与版本，修订即换 URL，正好符合
 * "拉过的 URL 永不重拉"；entry 的 urn:uuid 在同一事件修订时会变化。
 * @returns {{ id: string, title: string, updated: string, detailUrl: string }[]}
 */
export function parseNoaaEntries(text) {
  const s = String(text)
  // **先做 O(n) 早退守卫，再跑正则**：`<entry>[\s\S]*?</entry>` 这种惰性量词在没有闭合标签时会对
  // 每个起始位置一路回溯到串尾，复杂度是 O(n²)；而响应体上限是 512KB（DEFAULT_MAX_BODY_BYTES）。
  // 上游被截断或返回 HTML 拦截页时正是这种形态，会把 Host 的事件循环冻结数秒到几十秒。
  if (s.indexOf('</entry>') === -1) {
    // 空列表是正常形态（大多数时候没有海啸）；拦截页 / 被截断必须抛错，否则源坏掉与"没有海啸"同形。
    if (s.indexOf('<entry') !== -1) throw new Error('NOAA 事件列表被截断：有 <entry> 没有 </entry>')
    if (s.indexOf('<feed') === -1) throw new Error('NOAA 事件列表不是 Atom feed（可能是拦截页或错误页）')
  }
  const blocks = s.match(/<entry>[\s\S]*?<\/entry>/g) || []
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
