// ============================================================================
// dsh-quake-alert · client/src/06-matcher.js
// 作用：匹配引擎——决定一条 Alert 是否该提醒用户（区域匹配、阈值判定、未命中原因）；
//       依赖 01-constants、04-city-table（lookupAddrCity）、05h-overseas-parsers。
// ============================================================================

import { TSUNAMI_RANK } from './01-constants.js'
import { t } from './00-i18n.js'
import { own, placeOriginOf } from './02-storage.js'
import { lookupAddrCity, normKana } from './04-city-table.js'
import { OVERSEAS_BROADCAST_MIN_RANK } from './05h-overseas-parsers.js'

// 关注地区匹配：县级始终生效（watch.prefectures 为空 = 全日本）；市级只在数据本身有市区町村粒度
// 时收窄（cityLevel）。放行两类：区域级数据（对应不到市町村）、addr 认不出市町村。
function regionInWatch(region, watch, cityLevel, anyResolvedPref) {
  const list = watch && watch.prefectures
  const cities = (watch && watch.cities) || []
  // region.pref 为空 = 归属县未能识别，不能一律放行：552 / 556 的县级过滤是唯一的收窄手段，
  // 一律放行会让含"未收录预报区名"的海啸电文提醒所有关注列表非空的用户。
  // 口径：同一条消息里只要有区域能归到县，归不到的条目不参与县级过滤；全都归不到县时才放行。
  if (list && list.length > 0) {
    if (region.pref) {
      if (list.indexOf(region.pref) === -1) return false
    } else if (anyResolvedPref) {
      return false
    }
  }
  if (!cityLevel || cities.length === 0) return true
  if (region.cityKnown === false) return true
  const addrCity = lookupAddrCity(region.area)
  if (!addrCity) return true
  return cities.indexOf(addrCity) !== -1
}

// 气象警报（泥石流 / 洪水 / 大雨 / 高潮…）的关注地区匹配。与 551 不同：JMA 电文的区域在解析阶段
// 就已归到「县 + 市町村」，不再做 addr 反查。放行两类：pref 为空（无法判定）、区域级条目（city 为空）。
// 市町村比对走 normKana 等价（「金ケ崎町」vs「金け崎町」），直接 indexOf 会让已勾选的用户漏报。
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
// 全球源只给「震中坐标 + 震级」，用户按「位置 + 半径」关注，这里做球面距离判定（Haversine）；
// 坐标缺失时如实说明无法判定，不猜、不静默放行。
const EARTH_RADIUS_KM = 6371
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.pow(Math.sin(dLat / 2), 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.pow(Math.sin(dLon / 2), 2)
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}
/** 坐标是否可用于计算：数值、有限、且在合法范围内（-200 这类"未知"特殊标记值会被挡下）。 */
function validGeo(geo) {
  return !!geo && typeof geo.lat === 'number' && Number.isFinite(geo.lat) &&
    typeof geo.lon === 'number' && Number.isFinite(geo.lon) &&
    Math.abs(geo.lat) <= 90 && Math.abs(geo.lon) <= 180
}
/**
 * 坐标型警报的匹配：震中落在任一关注点的半径内即命中；震级阈值单独判断。
 * @returns {{ hit: boolean, reason: string, place?: object, distanceKm?: number }}
 */
function matchPointAlert(alert, cfg) {
  const places = (cfg.watch && cfg.watch.places) || []
  if (places.length === 0) {
    return { hit: false, reason: t('reason.noGlobalWatch') }
  }
  // 多区域电文（CAP 允许一个 info 下多个 <area><circle>）：任一圆心落在半径内即算命中，只看第一个
  // circle 会让其余海域的沿海用户漏报。
  const pts = (Array.isArray(alert.geoList) && alert.geoList.length ? alert.geoList : [alert.geo]).filter(validGeo)
  if (pts.length === 0) {
    return { hit: false, cannotJudge: true, reason: t('reason.noCoordinates') }
  }
  // 海啸等级门槛同样适用于全球源：NOAA CAP 的 <event> 决定等级，与日本 552 的 tsunamiGrade 共用
  // 一把尺（Warning=3 / Advisory・Watch=2 / Information=0）。
  if (alert.kind === 'tsunami') {
    const rank = typeof alert.tsunamiRank === 'number'
      ? alert.tsunamiRank
      : (typeof alert.maxScale === 'number' ? alert.maxScale : 0)
    const minRank = own(TSUNAMI_RANK, (cfg.thresholds || {}).tsunamiGrade) || 1
    if (rank < minRank) {
      return { hit: false, reason: t('reason.tsunamiBelowGrade', { rank: rank, min: minRank }) }
    }
  }
  // 震级门槛分两把：坐标型预警（EMSC / USGS / cenc_eew）用 th.globalMagnitude，
  // 大陆速报（cenc_eqlist，alert.speedReport）用 th.cnReportMagnitude。
  const th = cfg.thresholds || {}
  const minMag = alert.speedReport ? th.cnReportMagnitude : th.globalMagnitude
  const magName = alert.speedReport ? t('reason.magThresholdReport') : t('reason.magThresholdGlobal')
  const mag = typeof alert.magnitude === 'number' && Number.isFinite(alert.magnitude) ? alert.magnitude : null
  // 震级阈值只作用于地震：海啸的严重性由自己的等级决定，NOAA 电文里的前震震级只是参考值。
  const quakeLike = alert.kind === 'quake' || alert.kind === 'eew'
  if (quakeLike && mag !== null && typeof minMag === 'number' && mag < minMag) {
    return { hit: false, reason: t('reason.magBelow', { mag: mag, name: magName, min: minMag }) }
  }
  let nearest = null
  for (const g of pts) {
    for (const p of places) {
      const d = distanceKm(g.lat, g.lon, p.lat, p.lon)
      if (!nearest || d < nearest.d) nearest = { p, d }
      if (d <= p.radiusKm) {
        return {
          hit: true,
          reason: t('reason.pointHit', { mag: (mag === null ? '' : t('reason.magOnly', { mag: mag }) + ' · '), place: p.name, km: Math.round(d), radius: p.radiusKm }),
          place: p,
          distanceKm: d,
        }
      }
    }
  }
  return {
    hit: false,
    reason: t('reason.nearestWatch', { place: nearest.p.name, km: Math.round(nearest.d), radius: nearest.p.radiusKm }),
  }
}

// 未命中原因：若存在未能识别归属县的区域名，明确提示，避免用户误以为链路故障
function missReason(alert, watch, base) {  const list = watch && watch.prefectures
  const cities = (watch && watch.cities) || []
  let reason = base
  if (list && list.length > 0) {
    const unknown = alert.regions.filter((r) => !r.pref).length
    if (unknown > 0) reason = t('reason.missUnknownAreas', { base: base, n: unknown })
  }
  if (cities.length > 0) reason += t('reason.missNarrowedByCities', { n: cities.length })
  return reason
}

// ---------- 行政区层级匹配（大陆气象源） ----------
/**
 * 「省·市」名字 → 行政区对（分隔符是 U+00B7，以免两个省的"城区"撞名）。
 * 只服务老配置（place 上只有名字、没有显式 province / city）的解析，**不是**"这个点算不算
 * 大陆点"的判据——那个判据是 `origin`，见 cnWatchPlaces。
 */
function cnPlaceParts(name) {
  const s = String(name === undefined || name === null ? '' : name).trim()
  const i = s.indexOf('·')
  if (i <= 0 || i === s.length - 1) return null
  return { province: s.slice(0, i), city: s.slice(i + 1) }
}

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '')

// 一条大陆关注点都没配时的说明；noWatch 的条目在 11-pipeline 里不进历史。
const NO_CN_WATCH_REASON = t('reason.noCnWatch')

/**
 * 从关注点列表里挑出**大陆关注点**（判据是 placeOriginOf 给的 origin，与 normalizePlaces 同一个
 * 函数，两处口径不会漂开），并给出每条的省 / 市：优先读 place 上的显式字段，缺失时回退解析
 * 「省·市」名字——回退只发生在已确定是大陆点之后。
 */
function cnWatchPlaces(places) {
  const out = []
  for (const p of places) {
    if (!p) continue
    if (placeOriginOf(p, p.name) !== 'cn') continue
    let province = trimmed(p.province)
    let city = trimmed(p.city)
    if (!province || !city) {
      const parts = cnPlaceParts(p.name)
      if (parts) {
        if (!province) province = parts.province
        if (!city) city = parts.city
      }
    }
    out.push({ place: p, province, city })
  }
  return out
}

// 等级词与灾种名是界面用语（不是电文原文）→ 按界面语言取词
const NMC_LEVEL_KEY = { red: 'kind.cnLevelRed', orange: 'kind.cnLevelOrange', yellow: 'kind.cnLevelYellow', blue: 'kind.cnLevelBlue' }

/**
 * 大陆气象预警的匹配，规则按优先级排：灾种开关 → 有无大陆关注点（无则 noWatch）→ 播报门槛
 * （橙色及以上）→ 归属（市对上用市；市对不上按省放行；连省都认不出也放行）。
 */
function matchCnAreaAlert(alert, cfg) {
  const d = cfg.disasters || {}
  if (alert.cnKind === 'geology') {
    if (d.cnGeology === false) return { hit: false, reason: t('reason.cnGeologyOff') }
  } else if (d.cnRainstorm === false) {
    return { hit: false, reason: t('reason.cnRainstormOff') }
  }
  if (alert.cancelled) return { hit: false, reason: t('reason.clearedMuted') }
  // 等级词与灾种名都是界面用语（不是电文原文）→ 按界面语言取词
  const levelWord = t(NMC_LEVEL_KEY[alert.cnLevel] || 'kind.cnLevelUnknown')
  const kindWord = t(alert.cnKind === 'geology' ? 'kind.cnGeology' : 'kind.cnRainstorm')
  const what = t('kind.cnWhat', { kind: kindWord, level: levelWord })
  const places = (cfg.watch && cfg.watch.places) || []
  const cnPlaces = cnWatchPlaces(places)
  if (cnPlaces.length === 0) {
    // 没有关注点就明确说明怎么加，不静默；noWatch 让 11-pipeline 把这一类和"命中了但不在列表里"
    // 区分开（前者不进历史），所以它必须排在门槛之前。
    return { hit: false, noWatch: true, reason: NO_CN_WATCH_REASON }
  }
  const rank = typeof alert.cnRank === 'number' ? alert.cnRank : 0
  if (rank < 3) {
    return { hit: false, reason: t('reason.cnLandslideOnlyRecorded', { what: what }) }
  }
  const area = alert.cnArea || {}
  const province = String(area.province || '')
  const city = String(area.city || '')
  if (city) {
    const hit = cnPlaces.find((p) => p.province === province && p.city === city)
    if (hit) {
      return { hit: true, reason: t('reason.cnHit', { what: what, province: hit.province, city: hit.city }), place: hit.place }
    }
    return {
      hit: false,
      reason: t('reason.cnNotWatched', { what: what, province: province, city: city }),
    }
  }
  // 市级归属未知：省内有任何一个关注点就放行，并在 reason 里说明只定位到省（省直辖县、省台发布、
  // 机构名错字都属这一类）；省名也认不出时按全国放行。
  const sameProv = cnPlaces.filter((p) => !province || p.province === province)
  if (sameProv.length > 0) {
    return {
      hit: true,
      reason: province
      ? t('reason.cnProvinceOnly', { what: what, province: province, org: (area.org || t('reason.cnOrgPlaceholder')) })
      : t('reason.cnNoProvince', { what: what }),
      place: sameProv[0].place,
    }
  }
  return { hit: false, reason: t('reason.cnOrgUnknown', { what: what, org: (area.org || t('reason.cnOrgNameUnknown')) }) }
}

/**
 * 海外气象源的命中判定：**查询即匹配**——取数器按关注点查 NWS 的 `?point=` / ECCC 的 `?bbox=`，
 * 归属在取数时就已确定，这里不算距离。三个判定都是漏报防线：关注点被删了如实说明、档位不够不播报
 * （也不进历史）、取数器没记归属就明确说无法判定。
 */
function matchOverseasAlert(alert, cfg) {
  const d = cfg.disasters || {}
  if (d.overseasWeather === false) return { hit: false, reason: t('reason.overseasWeatherOff') }
  // 防御性守卫：取消 / 解除消息的正常路径在 11-pipeline 里已由 handleCancelled 处理，走到这里
  // 的不是 cancelled。保留是为守住 matchAlert 的对外不变量——cancelled 的消息永不返回 hit。
  if (alert.cancelled) return { hit: false, reason: t('reason.cancelledMuted') }
  const places = (cfg.watch && cfg.watch.places) || []
  if (places.length === 0) {
    return {
      hit: false,
      noWatch: true,
      reason: t('reason.noOverseasWatch'),
    }
  }
  const origin = alert.originPlace
  if (!origin) return { hit: false, cannotJudge: true, reason: t('reason.overseasNoOrigin') }
  // 关注点还在不在按"名字 + 坐标"比对（用户只改半径时仍是同一个点）
  const still = places.some((p) => p && p.name === origin.name && p.lat === origin.lat && p.lon === origin.lon)
  if (!still) {
    return { hit: false, reason: t('reason.overseasOriginGone', { place: (origin.name || t('reason.placeUnnamed')) }) }
  }
  const rank = typeof alert.overseasRank === 'number' ? alert.overseasRank : 0
  if (rank < OVERSEAS_BROADCAST_MIN_RANK) {
    return {
      hit: false,
      reason: t('reason.overseasBelowLevel', { headline: (alert.headline || t('reason.overseasHeadlineFallback')) }),
    }
  }
  return {
    hit: true,
    reason: t('reason.overseasHit', { place: (origin.name || t('reason.placeUnnamed')), headline: (alert.headline || '') }),
    place: origin,
  }
}

function matchAlert(alert, cfg) {
  const w = cfg.watch || {}
  // 局部变量不能叫 `t`：那是 00-i18n 的取词函数，遮蔽之后本函数里的 t('reason…') 会变成调用
  // 配置对象（TypeError）；check-imports 会拦这种遮蔽。
  const th = cfg.thresholds || {}
  // 这条消息里是否存在能归到县的区域：决定"归不到县的区域"要不要放行（见 regionInWatch）
  const anyPref = (alert.regions || []).some((r) => !!r.pref)
  if (alert.kind === 'eew' || alert.kind === 'quake') {
    if ((cfg.disasters || {}).earthquake === false) return { hit: false, reason: t('reason.quakeOff') }
    if (alert.cancelled) return { hit: false, reason: t('reason.cancelledMuted') }
    // 全球源（EMSC / USGS）只有震中坐标、没有行政区区域 → 走坐标匹配
    if (alert.locator === 'point') return matchPointAlert(alert, cfg)
    // 551 的「震源情报 / 远地地震」没有 points，无从按震度判定
    if (alert.regions.length === 0) {
      return {
        hit: false,
        cannotJudge: true,
        reason: alert.kind === 'eew' ? t('reason.eewNoAreaData') : t('reason.hypocenterOnly'),
      }
    }
    const threshold = alert.kind === 'eew' ? th.eewScale : th.quakeScale
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, alert.kind === 'quake', anyPref) && typeof r.scale === 'number' && r.scale >= threshold)
    return hitRegion
      ? { hit: true, reason: alert.kind === 'eew' ? t('reason.hitEewScale') : t('reason.hitObservedScale'), region: hitRegion }
      : { hit: false, reason: missReason(alert, w, t('reason.quakeMissed')) }
  }
  if (alert.kind === 'tsunami') {
    if ((cfg.disasters || {}).tsunami === false) return { hit: false, reason: t('reason.tsunamiOff') }
    if (alert.cancelled) return { hit: false, reason: t('reason.clearedMuted') }
    // NOAA CAP 的海啸同样是坐标型（CAP 里给的是 circle / polygon，不是津波予報区）
    if (alert.locator === 'point') return matchPointAlert(alert, cfg)
    if (alert.regions.length === 0) return { hit: false, cannotJudge: true, reason: t('reason.noTsunamiAreas') }
    const minRank = own(TSUNAMI_RANK, th.tsunamiGrade) || 1
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, false, anyPref) && (own(TSUNAMI_RANK, r.grade) || 0) >= minRank)
    return hitRegion
      ? { hit: true, reason: t('reason.hitTsunamiGrade'), region: hitRegion }
      : { hit: false, reason: missReason(alert, w, t('reason.tsunamiMissed')) }
  }
  if (alert.kind === 'weather') {
    // 海外气象源走**查询即匹配**：取数器按关注点查，归属在取数时已定，这里不做距离计算
    if (alert.locator === 'overseas') return matchOverseasAlert(alert, cfg)
    // 大陆气象源走**行政区层级**匹配，多一道等级门槛（橙色及以上才播报）
    if (alert.locator === 'area') return matchCnAreaAlert(alert, cfg)
    if ((cfg.disasters || {}).weather === false) return { hit: false, reason: t('reason.weatherOff') }
    if (alert.cancelled) return { hit: false, reason: t('reason.clearedMuted') }
    if (alert.regions.length === 0) return { hit: false, cannotJudge: true, reason: t('reason.jmaNoUsableArea') }
    // 播报边界写死在 L4：L1〜L3 仍然解析，但既不播报也不进历史（L3 是「高齢者等避難」，L4 才是
    // 避难指示级）。是否播报必须看命中地区**自己的**级别，不能看电文最大值：同一条 VPWW55 里姫路市 L4、
    // 相生市 L3、西脇市 L2 是常态，用电文最大值会把只到 L2 的地区播成「警戒レベル4」，还让市级收窄
    // 失去意义。region.level 缺失时（老对象 / 类型未识别）回退电文级别。
    const lvOf = (r) => (typeof r.level === 'number' ? r.level : alert.level)
    const hitRegion = alert.regions.find((r) => regionInWeatherWatch(r, w) && lvOf(r) >= 4)
    if (!hitRegion) {
      const anyL4 = alert.regions.some((r) => lvOf(r) >= 4)
      return {
        hit: false,
        reason: missReason(alert, w, anyL4
          ? t('reason.weatherMissedL4')
          : t('reason.weatherBelowL4', { level: (alert.level || '—') })),
      }
    }
    return {
      hit: true,
      reason: t('reason.hitLevel', { level: lvOf(hitRegion), area: (hitRegion.city || hitRegion.area) }),
      region: hitRegion,
    }
  }
  return { hit: false, cannotJudge: true, reason: t('reason.unsupportedCode') }
}


export { regionInWatch, regionInWeatherWatch, missReason, matchAlert, matchPointAlert, matchCnAreaAlert, matchOverseasAlert, cnPlaceParts, cnWatchPlaces, distanceKm, validGeo, EARTH_RADIUS_KM }
