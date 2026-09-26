// ============================================================================
// dsh-quake-alert · client/src/00-i18n.js
//
// 作用：界面语言的唯一入口（DESIGN 11.1 的 0.9.0 本地化）。
// 内容：语言清单与显示名、BCP 47 回退链、文案表汇总与自校验、t() 取词、setLanguage。
// 依赖：各 `00x-texts-*.js` 面文件（纯数据，不 import 任何模块）。
//
// 设计要点（DESIGN 11.9 / 11.10 的定稿）：
//   · **值域是插件自己的 BCP 47 清单**（zh-CN / ja / en），不对齐宿主的 zh/en——
//     宿主那份是界面语言包清单，且 zh 分不出简繁。Host 只校验 BCP 47 形状，白名单在这里。
//   · **加一种语言 = 这里加一项 + 补一份文案表**。每份面文件都必须覆盖 LANGS 的全部语言，
//     漏一份、漏一条 key 都会在**模块加载期**抛错（响亮的失败，而不是静默回退成中文）。
//   · **只翻我们生成的文本**：源侧的 headline / detail / 地名 / kindLabel / 各源 reason
//     一律原样透传（11.10）。所以 t() 里不该出现源的文本。
//   · **zh-CN 一栏逐字等于 0.8.2 的界面文案**：默认语言下的输出与本地化之前完全一致，
//     这样既有回归断言（大量以中文字符串为锚点）继续有效，用户可见行为也没变。
//
// t() 取不到 key 时**回显 key 本身**（例如 `settings.watch.title`）。宁可让界面上出现一个
// 明显的占位符，也不要静默显示空白或退回中文——前者一眼能看出来并被抓进测试。
// ============================================================================

import { CORE } from './00a-texts-core.js'
import { SETTINGS } from './00b-texts-settings.js'
import { CONFIG_IO } from './00c-texts-configio.js'
import { UNITS } from './00e-texts-units.js'

// ---------- 语言清单（顺序即设置页下拉顺序） ----------
/** 支持的语言，BCP 47 完整标识。加语言只改这一行 + 补一份表。 */
const LANGS = ['zh-CN', 'ja', 'en']
/** 默认语言。也是「配置里的值认不出」时的回退终点。 */
const DEFAULT_LANGUAGE = 'zh-CN'
/** 语言显示名：按**该语言自己**的写法（语言选择器不该出现"看不懂自己语言名"的情况）。 */
const LANGUAGE_LABELS = { 'zh-CN': '简体中文', ja: '日本語', en: 'English' }

// ---------- 文案表汇总 ----------
/** 全部面文件。新增一个面（如设置页）时加进来即可。 */
const PARTS = [CORE, SETTINGS, CONFIG_IO, UNITS]

/**
 * 把面文件按语言合并成 `{ lang: { key: text } }`，并当场校验：
 *   ① 每份面文件覆盖了 LANGS 的每一种语言；
 *   ② 每份面文件内部，各语言的 key 集合完全相同（防「漏翻一条」）；
 *   ③ 不同面文件之间没有重复 key（防「后一份悄悄覆盖前一份」）。
 * 任一条不满足就抛错——bundle 装载即失败，比一条悄悄失效的断言更早、更明确。
 */
function mergeParts(parts) {
  // 每个语言还得有**显示名**（语言下拉的 label）。漏了的话 `LANGUAGE_OPTIONS` 会产出
  // `{ v: 'ko', label: undefined }`——"加一种语言漏一步"的沉默失败，装载期就把它拦住
  // （加语言 = LANGS 加一项 + LANGUAGE_LABELS 加一项 + 每份面补一栏，三者缺一不可）。
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
 * 把任意值解析成清单里的语言（BCP 47 惯例的逐级回退）：
 *   精确匹配（大小写不敏感） → 主语言匹配（`zh-HK` → `zh` → `zh-CN`；`ja-JP` → `ja`） → 默认语言。
 * 逐级回退的意义：`zh-HK` / `zh-TW` 的用户拿到简体中文，而不是掉到英文去。
 */
function resolveLang(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim()
  if (!raw) return DEFAULT_LANGUAGE
  const lower = raw.toLowerCase()
  const exact = LANGS.find((l) => l.toLowerCase() === lower)
  if (exact) return exact
  const base = lower.split('-')[0]
  const byBase = LANGS.find((l) => l.split('-')[0].toLowerCase() === base)
  return byBase || DEFAULT_LANGUAGE
}

/** 设置当前界面语言（值认不出时按回退链落到默认语言）。返回生效后的值。 */
function setLanguage(value) {
  currentLang = resolveLang(value)
  return currentLang
}

function getLanguage() { return currentLang }

/** 取词。params 用于替换 `{name}`；缺 key 时回显 key 本身（见文件头）。 */
function t(key, params) {
  const k = String(key)
  const table = TABLES[currentLang] || TABLES[DEFAULT_LANGUAGE]
  // 用 `hasOwnProperty` 而不是直接 `table[k]`：key 恰好是 `constructor` / `toString` / `valueOf`
  // 这类名字时，后者会命中原型链拿到一个函数——"缺 key 回显 key"的承诺不成立，而且带参数时
  // 会在 `.replace` 上抛 TypeError。项目在 02-storage 的 `own()` 里立过同一条约定。
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

/** 某语言的整张表（回归用：校验三语 key 集合一致、zh-CN 与旧字面量一致）。 */
function tableOf(lang) {
  return TABLES[resolveLang(lang)] || TABLES[DEFAULT_LANGUAGE]
}

/** 语言清单的只读副本（设置页下拉与 Host 形状断言用）。 */
function languageList() { return LANGS.slice() }

export {
  LANGS, DEFAULT_LANGUAGE, LANGUAGE_LABELS, TABLES,
  resolveLang, setLanguage, getLanguage, t, tableOf, languageList,
}
