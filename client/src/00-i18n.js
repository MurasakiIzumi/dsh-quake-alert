// ============================================================================
// dsh-quake-alert · client/src/00-i18n.js
//
// 作用：界面语言的唯一入口——语言清单与显示名、BCP 47 回退链、文案表汇总与自校验、t() 取词。
// 依赖：各 `00x-texts-*.js` 文案文件（纯数据，不 import 任何模块）。
//
// 语言值域是本文件自己的 BCP 47 清单，不对齐宿主的 zh / en（宿主只校验 BCP 47 形状）。
// 加一种语言 = LANGS 加一项 + LANGUAGE_LABELS 加一项 + 每份文案文件补一栏，三者缺一不可；
// 漏一份语言或漏一条 key 都在加载期抛错。只翻我们生成的文本，源侧 headline / detail /
// 地名 / kindLabel / reason 一律原样透传。t() 取不到 key 时回显 key 本身。
// ============================================================================

import { CORE } from './00a-texts-core.js'
import { SETTINGS } from './00b-texts-settings.js'
import { CONFIG_IO } from './00c-texts-configio.js'
import { UNITS } from './00e-texts-units.js'
import { EVENTS } from './00g-texts-events.js'
import { REASONS } from './00h-texts-reasons.js'

// ---------- 语言清单（顺序即设置页下拉顺序） ----------
/** 支持的语言，BCP 47 完整标识。加语言要同时改 LANGS、LANGUAGE_LABELS 与每份文案表。 */
const LANGS = ['zh-CN', 'zh-TW', 'ja', 'en']
/** 默认语言。也是「配置里的值认不出」时的回退终点。 */
const DEFAULT_LANGUAGE = 'zh-CN'
/** 语言显示名：按该语言自己的写法（语言选择器里不出现用户看不懂的自己语言名）。 */
const LANGUAGE_LABELS = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', en: 'English' }

/**
 * 繁体侧的地区子标签（小写比较）；脚本子标签 `hant` / `hans` 在 resolveLang 里单独处理。
 * 中文的地区变体不能像 `ja-JP` 那样按主语言匹配：`zh-HK` / `zh-TW` 的用户要繁体，
 * 而按主语言匹配只会落到清单里第一个 `zh-*`（`zh-CN`），界面上看不出异常。
 */
const HANT_REGIONS = ['tw', 'hk', 'mo']

// ---------- 文案表汇总 ----------
const PARTS = [CORE, SETTINGS, CONFIG_IO, UNITS, EVENTS, REASONS]

/**
 * 把文案文件按语言合并成 `{ lang: { key: text } }`，并当场校验：每份文案文件覆盖 LANGS 的每一种语言、
 * 内部各语言的 key 集合完全相同、不同文案文件之间没有重复 key。任一条不满足就抛错，装载即失败。
 */
function mergeParts(parts) {
  // 每个语言还得有显示名（语言下拉的 label），否则 LANGUAGE_OPTIONS 会产出 label: undefined
  for (const lang of LANGS) {
    if (typeof LANGUAGE_LABELS[lang] !== 'string' || !LANGUAGE_LABELS[lang]) {
      throw new Error('i18n 语言缺显示名（LANGUAGE_LABELS）：' + lang)
    }
  }
  const tables = {}
  for (const lang of LANGS) tables[lang] = {}
  for (const part of parts) {
    for (const lang of LANGS) {
      if (!part[lang]) throw new Error('i18n 文案表缺语言：' + lang)
    }
    const baseKeys = Object.keys(part[LANGS[0]]).sort()
    for (const lang of LANGS.slice(1)) {
      const curKeys = Object.keys(part[lang])
      const missing = baseKeys.filter((k) => !Object.prototype.hasOwnProperty.call(part[lang], k))
      const extra = curKeys.filter((k) => !baseKeys.includes(k))
      if (missing.length || extra.length) {
        throw new Error('i18n 表不齐（' + lang + '）：缺 [' + missing.join(', ') + '] 多 [' + extra.join(', ') + ']')
      }
    }
    for (const lang of LANGS) {
      for (const k of Object.keys(part[lang])) {
        if (Object.prototype.hasOwnProperty.call(tables[lang], k)) {
          throw new Error('i18n key 重复：' + lang + ' / ' + k)
        }
        tables[lang][k] = part[lang][k]
      }
    }
  }
  return tables
}

const TABLES = mergeParts(PARTS)

// ---------- 当前语言 ----------
let currentLang = DEFAULT_LANGUAGE

/**
 * 把任意值解析成清单里的语言，逐级回退：精确匹配（大小写不敏感）→ 中文按脚本 / 地区分流
 * （`zh-TW` / `zh-HK` / `zh-Hant` → `zh-TW`，`zh` / `zh-CN` / `zh-SG` / `zh-Hans` → `zh-CN`）
 * → 其它主语言匹配（`ja-JP` → `ja`）→ 默认语言。
 */
function resolveLang(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim()
  if (!raw) return DEFAULT_LANGUAGE
  const lower = raw.toLowerCase()
  const exact = LANGS.find((l) => l.toLowerCase() === lower)
  if (exact) return exact
  const parts = lower.split('-')
  // 中文这一支必须先看脚本与地区子标签，再看主语言：清单里主语言匹配只取第一个 `zh-*`（简体）。
  // 且脚本优先于地区：`zh-Hans-HK` 是简体字形 + 香港地区，判成繁体是错的；`zh-Hant-CN` 反之。
  if (parts[0] === 'zh') {
    const subs = parts.slice(1)
    if (subs.indexOf('hant') !== -1) return 'zh-TW'
    if (subs.indexOf('hans') !== -1) return 'zh-CN'
    return subs.some((p) => HANT_REGIONS.indexOf(p) !== -1) ? 'zh-TW' : 'zh-CN'
  }
  const byBase = LANGS.find((l) => l.split('-')[0].toLowerCase() === parts[0])
  return byBase || DEFAULT_LANGUAGE
}

/** 设置当前界面语言（值认不出时按回退链落到默认语言）。返回生效后的值。 */
function setLanguage(value) {
  currentLang = resolveLang(value)
  return currentLang
}

function getLanguage() { return currentLang }

/** 取词。params 用于替换 `{name}`；缺 key 时回显 key 本身。 */
function t(key, params) {
  const k = String(key)
  const table = TABLES[currentLang] || TABLES[DEFAULT_LANGUAGE]
  // 用 hasOwnProperty 而不是 `table[k]`：key 恰好叫 `constructor` / `toString` 时会命中原型链。
  let s = Object.prototype.hasOwnProperty.call(table, k) ? table[k] : undefined
  if (s === undefined) {
    const def = TABLES[DEFAULT_LANGUAGE]
    s = Object.prototype.hasOwnProperty.call(def, k) ? def[k] : undefined
  }
  if (s === undefined) return k
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
    ))
  }
  return s
}

/** 某语言的整张表（回归用：校验各语言 key 集合一致、zh-CN 与旧字面量一致）。 */
function tableOf(lang) {
  return TABLES[resolveLang(lang)] || TABLES[DEFAULT_LANGUAGE]
}

/** 语言清单的只读副本（设置页下拉与 Host 形状断言用）。 */
function languageList() { return LANGS.slice() }

export {
  LANGS, DEFAULT_LANGUAGE, LANGUAGE_LABELS, TABLES,
  resolveLang, setLanguage, getLanguage, t, tableOf, languageList,
}
