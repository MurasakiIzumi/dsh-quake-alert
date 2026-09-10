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
import { lookupAddrCity } from './04-city-table.js'

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

// 未命中原因：若存在未能识别归属县的区域名，明确提示，避免用户误以为链路故障
function missReason(alert, watch, base) {
  const list = watch && watch.prefectures
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
    if (alert.regions.length === 0) return { hit: false, reason: '本条没有海啸预报区数据' }
    const minRank = own(TSUNAMI_RANK, t.tsunamiGrade) || 1
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, false) && (own(TSUNAMI_RANK, r.grade) || 0) >= minRank)
    return hitRegion
      ? { hit: true, reason: '海啸等级达标', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中或等级低于阈值') }
  }
  return { hit: false, reason: '不支持的 code' }
}


export { regionInWatch, missReason, matchAlert }
