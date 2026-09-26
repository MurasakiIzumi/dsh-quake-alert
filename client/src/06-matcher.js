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
import { OVERSEAS_BROADCAST_MIN_RANK } from './05h-overseas-parsers.js'

// ---------- 匹配引擎 ----------
// 关注地区匹配：县级始终生效（watch.prefectures 为空 = 全日本）；市级只在数据本身有
// 市区町村粒度时收窄——即 551 的观测点条目（isArea=false，addr 形如「白河市新白河」）。
// 两类情况一律放行，宁可多提醒也绝不漏报：
//   ① 区域级数据：isArea=true 的区域名、556 的区域名、552 的津波予報区名都对应不到市町村；
//   ② addr 归一不到任何市町村：机场观测点（新千歳空港）、未收录写法等。
function regionInWatch(region, watch, cityLevel, anyResolvedPref) {
  const list = watch && watch.prefectures
  const cities = (watch && watch.cities) || []
  // region.pref 为空 = 归属县未能识别。这里**不能简单地一律放行**（0.4.2 修正）：
  // 552/556 走的是 cityLevel=false，县级过滤是**唯一**的收窄手段，一律放行会让一条含
  // "未收录预报区名"的海啸电文提醒**所有关注列表非空的用户**（海啸域的误报最伤信任）。
  // 口径：同一条消息里只要**有**区域能归到县，归不到的条目不参与县级过滤（不因它命中）；
  // 只有当整条消息的区域**全都**归不到县时，才为了不漏报而放行（DESIGN 3.2 的"边界情况让步"）。
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
    return { hit: false, reason: '未设置全球关注点（设置 → 灾害预警 → 关注地区 → 其他国家 / 地区）' }
  }
  // 多区域电文（CAP 允许一个 info 下多个 <area><circle>）：任一圆心落在半径内即算命中。
  // 只看第一个 circle 会让其余海域的沿海用户漏报——多区域海啸恰恰是最常见形态。
  const pts = (Array.isArray(alert.geoList) && alert.geoList.length ? alert.geoList : [alert.geo]).filter(validGeo)
  if (pts.length === 0) {
    return { hit: false, reason: '本条消息未携带可用坐标，无法判定震中距' }
  }
  // 海啸的**等级闸门**同样适用于全球源（0.4.1）。NOAA CAP 的 <event> 决定等级
  // （Warning=3 / Advisory・Watch=2 / Information=0，见 05c 的 NOAA_EVENT_RULES），
  // 与日本 552 的 tsunamiGrade 共用同一把尺。此前这条闸门只作用于日本源，于是
  // 「Tsunami Information」（气象机构明确表示无破坏性海啸的信息）也会在半径内响铃——
  // 全球海啸完全无法用等级收敛，而海啸的误报会直接摧毁用户对整条链路的信任。
  if (alert.kind === 'tsunami') {
    const rank = typeof alert.tsunamiRank === 'number'
      ? alert.tsunamiRank
      : (typeof alert.maxScale === 'number' ? alert.maxScale : 0)
    const minRank = own(TSUNAMI_RANK, (cfg.thresholds || {}).tsunamiGrade) || 1
    if (rank < minRank) {
      return { hit: false, reason: '海啸等级未达阈值（本条 ' + rank + ' < ' + minRank + '）' }
    }
  }
  // 震级门槛分两把（0.5.0）：坐标型**预警**（EMSC / USGS / cenc_eew）用 globalMagnitude，
  // 大陆**速报**（cenc_eqlist，alert.speedReport）用独立的 cnReportMagnitude——速报覆盖低到
  // M2.5 且每天都有数据，用预警门槛播报会被小震频繁打扰（DESIGN 8.4）。
  const th = cfg.thresholds || {}
  const minMag = alert.speedReport ? th.cnReportMagnitude : th.globalMagnitude
  const magName = alert.speedReport ? '速报震级阈值' : '全球震级阈值'
  const mag = typeof alert.magnitude === 'number' && Number.isFinite(alert.magnitude) ? alert.magnitude : null
  // 震级阈值只作用于地震。海啸的严重性由它自己的等级决定（上面的闸门），
  // 不该被"引发它的那次地震有多大"过滤掉：NOAA 电文里那个前震震级只是参考值，而且用同一个
  // 阈值卡海啸是危险的——用户把全球阈值调到 M7.0 时，一场 M6.7 引发的海啸警报会被静默丢掉，
  // 而海啸恰恰是这里最不能漏的一类。
  const quakeLike = alert.kind === 'quake' || alert.kind === 'eew'
  if (quakeLike && mag !== null && typeof minMag === 'number' && mag < minMag) {
    return { hit: false, reason: 'M' + mag + ' 低于' + magName + ' M' + minMag }
  }
  let nearest = null
  for (const g of pts) {
    for (const p of places) {
      const d = distanceKm(g.lat, g.lon, p.lat, p.lon)
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

// ---------- 行政区层级匹配（大陆气象源，0.5.2 / DESIGN 8.5） ----------
/**
 * 关注点名字 → 行政区对。设置页「中国大陆」加进来的点由 04-city-table 的 cnPlaceOf 生成，
 * 名字固定是「省·市」（用 U+00B7 分隔，以免两个省的"城区"撞名）。
 * 不含分隔符的点（手填坐标、全球关注点）返回 null——**行政区层级匹配不适用于它们**，
 * 忽略而不是报错：同一个 places 列表同时服务坐标型源（地震）与行政型源（气象）。
 */
function cnPlaceParts(name) {
  const s = String(name === undefined || name === null ? '' : name).trim()
  const i = s.indexOf('·')
  if (i <= 0 || i === s.length - 1) return null
  return { province: s.slice(0, i), city: s.slice(i + 1) }
}

/** 等级中文（与 05f 的 NMC_LEVEL_TEXT 同源；这里只需要拼 reason，不复制映射表会更好，
 *  但 06 不该依赖解析层——所以就地写一份最小的，并靠回归断言钉住两边一致。 */
const NMC_LEVEL_ZH = { red: '红色', orange: '橙色', yellow: '黄色', blue: '蓝色' }

/**
 * 大陆气象预警的匹配。规则按优先级排，每一条都对应一个"用户会问为什么"的场景：
 *
 *  ① 灾种开关（DESIGN 8.4 把它们拆成两个：暴雨的橙 / 红常年可见，地质灾害实测全是黄色）。
 *  ② 播报门槛：**橙色及以上**才打扰，黄 / 蓝只入历史。不满足时 reason 要说清是"等级不够"，
 *     而不是含糊的"未命中"——否则用户会把"这条预警我收到了但没响"读成故障。
 *  ③ 归属：市能对上就用市；市对不上（省直辖县 / 省台发布 / 机构名错字）时**按省放行**；
 *     连省都认不出（国家级机构等）也放行。后两条都是 DESIGN 3.2 / 8.5 的"宁可多报绝不漏报"
 *     ——一次漏报的代价远大于一次多报。
 */
function matchCnAreaAlert(alert, cfg) {
  const d = cfg.disasters || {}
  if (alert.cnKind === 'geology') {
    if (d.cnGeology === false) return { hit: false, reason: '大陆地质灾害提醒已关闭' }
  } else if (d.cnRainstorm === false) {
    return { hit: false, reason: '大陆暴雨提醒已关闭' }
  }
  if (alert.cancelled) return { hit: false, reason: '解除消息不提醒' }
  const levelZh = NMC_LEVEL_ZH[alert.cnLevel] || String(alert.cnLevel || '')
  const what = (alert.cnKind === 'geology' ? '地质灾害' : '暴雨') + levelZh + '预警'
  const rank = typeof alert.cnRank === 'number' ? alert.cnRank : 0
  if (rank < 3) {
    return { hit: false, reason: what + '（未达橙色，仅记录）' }
  }
  const places = (cfg.watch && cfg.watch.places) || []
  const cnPlaces = []
  for (const p of places) {
    const parts = cnPlaceParts(p && p.name)
    if (parts) cnPlaces.push({ place: p, province: parts.province, city: parts.city })
  }
  if (cnPlaces.length === 0) {
    // 与坐标型源同一条原则：没有关注点就明确说明怎么加，**不静默**——
    // "配错了关注点"看起来像"根本没有预警"是这套系统最该避免的误解之一。
    // `noWatch` 让 11-pipeline 能把这一类和"命中了但不在列表里"区分开（前者不进历史，0.5.4）。
    return {
      hit: false,
      noWatch: true,
      reason: '未设置中国大陆关注点（设置 → 灾害预警 → 关注地区 → 中国大陆 → 选省与城市）',
    }
  }
  const area = alert.cnArea || {}
  const province = String(area.province || '')
  const city = String(area.city || '')
  if (city) {
    const hit = cnPlaces.find((p) => p.province === province && p.city === city)
    if (hit) {
      return { hit: true, reason: what + ' · 命中关注点 ' + hit.province + '·' + hit.city, place: hit.place }
    }
    return {
      hit: false,
      reason: what + '（' + province + '·' + city + '）不在关注列表里',
    }
  }
  // 市级归属未知：省内有任何一个关注点就放行，并在 reason 里如实说明只定位到省。
  // 实测这一类的来源是海南省直辖县（乐东 / 昌江 / 琼中…）、上海市辖区，以及上游的机构名错字
  //（「黑龙江省齐哈尔市克山县」少了"齐"）——它们都是真实预警，丢掉就是漏报。
  const sameProv = cnPlaces.filter((p) => !province || p.province === province)
  if (sameProv.length > 0) {
    return {
      hit: true,
      reason: what + ' · ' + (province ? '仅能定位到 ' + province + '（' + (area.org || '发布机构未给出市级）') + '）' : '未能定位到省份，按全国放行'),
      place: sameProv[0].place,
    }
  }
  return { hit: false, reason: what + ' · 归属未识别（' + (area.org || '机构名未知') + '）' }
}

/**
 * 海外气象源（0.6.0）的命中判定：**查询即匹配**（DESIGN 4.7.3）。
 *
 * 与 matchPointAlert 的根本差别：那边的语义是"震中距 ≤ 半径"，坐标在**电文里**；
 * 这边的语义是"这条预警属于用户关注的哪个点"，归属在**取数时就确定了**
 * （取数器按关注点查 NWS 的 `?point=` / ECCC 的 `?bbox=`），所以这里不算距离——
 * 算也没有意义：NWS 返回的是"该点所在县 / 区划"的预警，一个县没有"距关注点多少公里"。
 *
 * 剩下的三个判定都是"用户看不见的漏报"防线：
 *   ① 关注点被删了（用户改配置后取数器要下一轮才生效）→ 如实说明，不当成命中；
 *   ② 档位不够（NWS 的 Watch / Advisory / Statement）→ 只记历史，不打扰；
 *   ③ 取数器没记归属（理论上不该发生）→ 不猜，明确说"无法判定"。
 */
function matchOverseasAlert(alert, cfg) {
  const d = cfg.disasters || {}
  if (d.overseasWeather === false) return { hit: false, reason: '海外气象提醒已关闭' }
  // **防御性守卫，不是本函数的正常输入路径**（0.6.1 review 订正注释）：取消 / 解除消息由
  // 11-pipeline 的 handleAlert 在 matchAlert **之前**就交给 handleCancelled 了，所以线上
  // 走到这里的一定不是 cancelled。保留它是为了守住 matchAlert 的对外不变量——"cancelled 的
  // 消息永远不返回 hit"，避免将来多一条调用路径时把一条"已作废"当成新警报播出去。
  if (alert.cancelled) return { hit: false, reason: '取消消息不提醒' }
  const places = (cfg.watch && cfg.watch.places) || []
  if (places.length === 0) {
    return {
      hit: false,
      noWatch: true,
      reason: '未设置海外关注点（设置 → 灾害预警 → 关注地区 → 其他国家 / 地区）',
    }
  }
  const origin = alert.originPlace
  if (!origin) return { hit: false, reason: '这条海外预警未携带来源关注点，无法判定' }
  // 关注点还在不在：按"名字 + 坐标"比对（用户只改半径时仍是同一个点，命中判定不变）。
  const still = places.some((p) => p && p.name === origin.name && p.lat === origin.lat && p.lon === origin.lon)
  if (!still) {
    return { hit: false, reason: '来源关注点「' + (origin.name || '未命名') + '」已不在关注列表里' }
  }
  const rank = typeof alert.overseasRank === 'number' ? alert.overseasRank : 0
  if (rank < OVERSEAS_BROADCAST_MIN_RANK) {
    return {
      hit: false,
      reason: (alert.headline || '海外气象预警') + '（未达播报档位，仅记录）',
    }
  }
  return {
    hit: true,
    reason: '命中关注点「' + (origin.name || '未命名') + '」· ' + (alert.headline || ''),
    place: origin,
  }
}

function matchAlert(alert, cfg) {
  const w = cfg.watch || {}
  const t = cfg.thresholds || {}
  // 这条消息里是否存在**能归到县**的区域：决定"归不到县的区域"要不要放行（见 regionInWatch）
  const anyPref = (alert.regions || []).some((r) => !!r.pref)
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
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, alert.kind === 'quake', anyPref) && typeof r.scale === 'number' && r.scale >= threshold)
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
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, false, anyPref) && (own(TSUNAMI_RANK, r.grade) || 0) >= minRank)
    return hitRegion
      ? { hit: true, reason: '海啸等级达标', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中或等级低于阈值') }
  }
  if (alert.kind === 'weather') {
    // 海外气象源（0.6.0）走**查询即匹配**：取数器是按关注点查的（NWS 按点、ECCC 按 bbox），
    // "这条属于哪个关注点"在取数时就已经确定，所以这里不做距离计算，只做归属与档位判定。
    if (alert.locator === 'overseas') return matchOverseasAlert(alert, cfg)
    // 大陆气象源（0.5.2）走**行政区层级**匹配，与日本电文那套（都道府县 + 市町村名）是两套
    // 规则：那边的粒度是市町村、兜底是"区域级条目放行"；这边的粒度是地级市、兜底是"省级放行"，
    // 而且多一道**等级门槛**（DESIGN 8.4：橙色及以上才播报）。
    if (alert.locator === 'area') return matchCnAreaAlert(alert, cfg)
    if ((cfg.disasters || {}).weather === false) return { hit: false, reason: '气象灾害提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '解除消息不提醒' }
    if (alert.regions.length === 0) return { hit: false, reason: '本条电文未携带可判定的区域' }
    // 播报边界写死在 L4：L1〜L3 仍然解析、仍然进历史（灰色条目），只是不打扰。
    // 依据见 DESIGN 10.3——L3 是「高齢者等避難」，与 DSH 用户群不匹配；L4 才是避难指示级。
    //
    // **闸门必须看命中地区自己的级别**，不能看电文最大值：同一条 VPWW55 里姫路市是
    // L4 大雨危険警報、相生市是 L3 大雨警報、西脇市是 L2 大雨注意報（2026-09-14 兵庫県实测）。
    // 用电文最大值会把只到 L2 的地区播成「警戒レベル4（避难指示级）」——内容夸大，
    // 而且让「市级收窄」彻底失去意义。region.level 缺失时（老对象 / 类型未识别）回退电文级别。
    const lvOf = (r) => (typeof r.level === 'number' ? r.level : alert.level)
    const hitRegion = alert.regions.find((r) => regionInWeatherWatch(r, w) && lvOf(r) >= 4)
    if (!hitRegion) {
      const anyL4 = alert.regions.some((r) => lvOf(r) >= 4)
      return {
        hit: false,
        reason: missReason(alert, w, anyL4
          ? '关注地区未命中，或命中地区未达 L4'
          : '警戒レベル' + (alert.level || '—') + '（未达 L4，仅记录）'),
      }
    }
    return {
      hit: true,
      reason: '警戒レベル' + lvOf(hitRegion) + '（' + (hitRegion.city || hitRegion.area) + '）',
      region: hitRegion,
    }
  }
  return { hit: false, reason: '不支持的 code' }
}


export { regionInWatch, regionInWeatherWatch, missReason, matchAlert, matchPointAlert, matchCnAreaAlert, matchOverseasAlert, cnPlaceParts, distanceKm, validGeo, EARTH_RADIUS_KM }
