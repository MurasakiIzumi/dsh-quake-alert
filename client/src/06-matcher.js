// ============================================================================
// dsh-quake-alert · client/src/06-matcher.js
//
// 作用：匹配引擎——决定一条 Alert 是否该提醒用户。
// 内容：regionInWatch（县级 + 市级收窄）、阈值判定（震度/海啸等级）、
//       missReason（未命中原因，含未识别区域名与市级收窄提示）。
// 依赖：01-constants、04-city-table（lookupAddrCity）。
// 放行规则：区域级数据与归一不到市町村的观测点一律放行，宁可多报绝不漏报。
// ============================================================================

import { TSUNAMI_RANK } from './01-constants.js'
import { own } from './02-storage.js'
import { lookupAddrCity, normKana } from './04-city-table.js'

// ---------- 匹配引擎 ----------
// 关注地区匹配：县级始终生效（watch.prefectures 为空 = 全日本）；市级只在数据本身有
// 市区町村粒度时收窄——即 551 的观测点条目（isArea=false，addr 形如「白河市新白河」）。
// 两类情况一律放行，宁可多提醒也绝不漏报：
//   ① 区域级数据：isArea=true 的区域名、556 的区域名、552 的津波予報区名都对应不到市町村；
//   ② addr 归一不到任何市町村：机场观测点（新千歳空港）、未收录写法等。
function regionInWatch(region, watch, cityLevel) {
  const list = watch && watch.prefectures
  const cities = (watch && watch.cities) || []
  if (list && list.length > 0 && list.indexOf(region.pref) === -1) return false
  if (!cityLevel || cities.length === 0) return true
  if (region.cityKnown === false) return true
  const addrCity = lookupAddrCity(region.area)
  if (!addrCity) return true
  return cities.indexOf(addrCity) !== -1
}

// 气象警报（泥石流 / 洪水 / 大雨 / 高潮…）的关注地区匹配。
// 与 551 不同，JMA 电文的区域在解析阶段就已经归到「县 + 市町村」，不需要再做 addr 归一；
// 两类一律放行，宁可多报绝不漏报：
//   ① pref 为空（区域码认不出县、或名称反查不到）——无法判定，放行；
//   ② 区域级条目（city 为空，如「宗谷地方」「○○川上流」）——对应不到市町村，放行。
// 市町村比对走 normKana 归一等价：电文/河川区域表的假名写法可能与本表不同
// （「金ケ崎町」vs「金け崎町」、「南アルプス市」vs「南あるぷす市」），
// 直接 indexOf 会让勾选了该市町村的用户漏报。
function regionInWeatherWatch(region, watch) {
  const list = (watch && watch.prefectures) || []
  const cities = (watch && watch.cities) || []
  if (list.length > 0 && region.pref && list.indexOf(region.pref) === -1) return false
  if (cities.length === 0) return true
  if (!region.city) return true
  const target = normKana(region.city)
  return cities.some((c) => normKana(c) === target)
}

// ---------- 坐标匹配（全球源：EMSC / USGS / NOAA CAP） ----------
// 全球源给的是「震中坐标 + 震级」，没有日本那样的都道府县 / 市町村。用户的关注表达因此是
// 「我所在的位置 + 可接受半径」，由这里做球面距离判定（Haversine，误差 <0.5%）。
// 与行政区匹配同一条原则：宁可多报绝不漏报；但坐标缺失时**不猜**——如实说明无法判定，
// 而不是默默放行（放行会让"配错了关注点"看起来像"根本没有地震"）。
const EARTH_RADIUS_KM = 6371
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.pow(Math.sin(dLat / 2), 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.pow(Math.sin(dLon / 2), 2)
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}
/** 坐标是否可用于计算：数值、有限、且在合法范围内（-200 这类"未知"哨兵值会被挡下）。 */
function validGeo(geo) {
  return !!geo && typeof geo.lat === 'number' && Number.isFinite(geo.lat) &&
    typeof geo.lon === 'number' && Number.isFinite(geo.lon) &&
    Math.abs(geo.lat) <= 90 && Math.abs(geo.lon) <= 180
}
/**
 * 坐标型警报的匹配：震中落在任一关注点的半径内即命中。
 * 震级阈值单独判断（globalMagnitude）——全球源给出的是震级，与日本的震度不可换算，
 * 用一个独立旋钮比"假装能换算"诚实。
 * @returns {{ hit: boolean, reason: string, place?: object, distanceKm?: number }}
 */
function matchPointAlert(alert, cfg) {
  const places = (cfg.watch && cfg.watch.places) || []
  if (places.length === 0) {
    return { hit: false, reason: '未设置全球关注点（设置 → 灾害预警 → 全球关注点）' }
  }
  if (!validGeo(alert.geo)) {
    return { hit: false, reason: '本条消息未携带可用坐标，无法判定震中距' }
  }
  const minMag = (cfg.thresholds || {}).globalMagnitude
  const mag = typeof alert.magnitude === 'number' && Number.isFinite(alert.magnitude) ? alert.magnitude : null
  // 震级阈值只作用于地震。海啸的严重性由它自己的等级决定（警报 / 注意报 / 信息），
  // 不该被"引发它的那次地震有多大"过滤掉：NOAA 电文里那个前震震级只是参考值，而且用同一个
  // 阈值卡海啸是危险的——用户把全球阈值调到 M7.0 时，一场 M6.7 引发的海啸警报会被静默丢掉，
  // 而海啸恰恰是这里最不能漏的一类。
  const quakeLike = alert.kind === 'quake' || alert.kind === 'eew'
  if (quakeLike && mag !== null && typeof minMag === 'number' && mag < minMag) {
    return { hit: false, reason: 'M' + mag + ' 低于全球震级阈值 M' + minMag }
  }
  let nearest = null
  for (const p of places) {
    const d = distanceKm(alert.geo.lat, alert.geo.lon, p.lat, p.lon)
    if (!nearest || d < nearest.d) nearest = { p, d }
    if (d <= p.radiusKm) {
      return {
        hit: true,
        reason: (mag === null ? '' : 'M' + mag + ' · ') + '距 ' + p.name + ' 约 ' + Math.round(d) +
          ' km（半径 ' + p.radiusKm + ' km）',
        place: p,
        distanceKm: d,
      }
    }
  }
  return {
    hit: false,
    reason: '震中距最近的关注点（' + nearest.p.name + '）约 ' + Math.round(nearest.d) +
      ' km，超过设定半径 ' + nearest.p.radiusKm + ' km',
  }
}

// 未命中原因：若存在未能识别归属县的区域名，明确提示，避免用户误以为链路故障
function missReason(alert, watch, base) {  const list = watch && watch.prefectures
  const cities = (watch && watch.cities) || []
  let reason = base
  if (list && list.length > 0) {
    const unknown = alert.regions.filter((r) => !r.pref).length
    if (unknown > 0) reason = base + '（另有 ' + unknown + ' 个区域名未能识别归属县）'
  }
  if (cities.length > 0) reason += '（已按所选 ' + cities.length + ' 个市区町村收窄）'
  return reason
}

function matchAlert(alert, cfg) {
  const w = cfg.watch || {}
  const t = cfg.thresholds || {}
  if (alert.kind === 'eew' || alert.kind === 'quake') {
    if ((cfg.disasters || {}).earthquake === false) return { hit: false, reason: '地震提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '取消消息不提醒' }
    // 全球源（EMSC / USGS）只有震中坐标、没有行政区区域 → 走坐标匹配
    if (alert.locator === 'point') return matchPointAlert(alert, cfg)
    // 551 的「震源情报 / 远地地震」没有 points，无从按震度判定——明确说明，避免用户误以为链路故障
    if (alert.regions.length === 0) {
      return {
        hit: false,
        reason: alert.kind === 'eew'
          ? '本条 EEW 未携带区域数据，无法按阈值判定'
          : '本条为震源情报，无震度数据，无法按阈值判定',
      }
    }
    const threshold = alert.kind === 'eew' ? t.eewScale : t.quakeScale
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, alert.kind === 'quake') && typeof r.scale === 'number' && r.scale >= threshold)
    return hitRegion
      ? { hit: true, reason: alert.kind === 'eew' ? 'EEW 预测震度达标' : '观测震度达标', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中或强度低于阈值') }
  }
  if (alert.kind === 'tsunami') {
    if ((cfg.disasters || {}).tsunami === false) return { hit: false, reason: '海啸提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '解除消息不提醒' }
    // NOAA CAP 的海啸同样是坐标型（CAP 里给的是 circle / polygon，不是日本的津波予報区）
    if (alert.locator === 'point') return matchPointAlert(alert, cfg)
    if (alert.regions.length === 0) return { hit: false, reason: '本条没有海啸预报区数据' }
    const minRank = own(TSUNAMI_RANK, t.tsunamiGrade) || 1
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, false) && (own(TSUNAMI_RANK, r.grade) || 0) >= minRank)
    return hitRegion
      ? { hit: true, reason: '海啸等级达标', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中或等级低于阈值') }
  }
  if (alert.kind === 'weather') {
    if ((cfg.disasters || {}).weather === false) return { hit: false, reason: '气象灾害提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '解除消息不提醒' }
    // 播报边界写死在 L4：L1〜L3 仍然解析、仍然进历史（灰色条目），只是不打扰。
    // 依据见 DESIGN 10.3——L3 是「高齢者等避難」，与 DSH 用户群不匹配；L4 才是避难指示级。
    if (!(typeof alert.level === 'number' && alert.level >= 4)) {
      return { hit: false, reason: '警戒レベル' + (alert.level || '—') + '（未达 L4，仅记录）' }
    }
    if (alert.regions.length === 0) return { hit: false, reason: '本条电文未携带可判定的区域' }
    const hitRegion = alert.regions.find((r) => regionInWeatherWatch(r, w))
    return hitRegion
      ? { hit: true, reason: '警戒レベル' + alert.level + '（' + (hitRegion.city || hitRegion.area) + '）', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中') }
  }
  return { hit: false, reason: '不支持的 code' }
}


export { regionInWatch, regionInWeatherWatch, missReason, matchAlert, matchPointAlert, distanceKm, validGeo, EARTH_RADIUS_KM }
