// ============================================================================
// dsh-quake-alert · client/src/00e-texts-units.js
//
// 作用：量纲类展示文案表（各语言并列）——震度、海啸等级、震级档位、关注半径档位。
// 内容：纯数据对象，不 import 任何模块。
// 依赖：无。
//
// 这些字符串此前住在 `01-constants.js` 的常量里（`SCALE_TEXT` / `SCALE_OPTIONS` /
// `TSUNAMI_GRADE_TEXT` / `TSUNAMI_OPTIONS` / `GLOBAL_MAG_OPTIONS` /
// `CN_REPORT_MAG_OPTIONS` / `RADIUS_PRESETS`）。搬到表里之后，那些常量保留为
// **值 + 文案 key**，`zh-CN` 一栏逐字等于搬走之前的原文（含其中的空格）。
//
// 震度的日文写法有讲究：`5弱` / `5強` 里的「強」是日文汉字，中文简体写作「强」——
// 两者在 zh-CN 与 ja 两栏里**故意不同**，照抄各自的通行写法，不要统一。
//
// 震级的档位文案由两个数组共用（`GLOBAL_MAG_OPTIONS` 与 `CN_REPORT_MAG_OPTIONS` 对同一个
// 数值给的是同一句话）。**若将来两者的默认值分家，这里必须拆成两组 key**——共用是基于
// "同值同文案"这个事实，不是约定。
// ============================================================================

const UNITS = {
  'zh-CN': {

    'scaleOpt.10': '震度1 以上', 'scaleOpt.20': '震度2 以上', 'scaleOpt.30': '震度3 以上',
    'scaleOpt.40': '震度4 以上', 'scaleOpt.45': '震度5弱 以上', 'scaleOpt.50': '震度5强 以上',
    'scaleOpt.55': '震度6弱 以上', 'scaleOpt.60': '震度6强 以上', 'scaleOpt.70': '震度7',

    'tsunamiOpt.Watch': '注意报及以上',
    'tsunamiOpt.Warning': '警报及以上',
    'tsunamiOpt.MajorWarning': '仅大海啸警报',

    'magOpt.3': 'M3.0 以上', 'magOpt.3.5': 'M3.5 以上', 'magOpt.4': 'M4.0 以上',
    'magOpt.4.5': 'M4.5 以上（默认）', 'magOpt.5': 'M5.0 以上', 'magOpt.5.5': 'M5.5 以上',
    'magOpt.6': 'M6.0 以上', 'magOpt.6.5': 'M6.5 以上', 'magOpt.7': 'M7.0 以上',

    'radius.30': '仅本地（约 30 km）',
    'radius.100': '本市及周边（约 100 km，默认）',
    'radius.300': '较大范围（约 300 km）'
  },

  'zh-TW': {

    'scaleOpt.10': '震度1 以上', 'scaleOpt.20': '震度2 以上', 'scaleOpt.30': '震度3 以上',
    'scaleOpt.40': '震度4 以上', 'scaleOpt.45': '震度5弱 以上', 'scaleOpt.50': '震度5強 以上',
    'scaleOpt.55': '震度6弱 以上', 'scaleOpt.60': '震度6強 以上', 'scaleOpt.70': '震度7',

    'tsunamiOpt.Watch': '注意報以上',
    'tsunamiOpt.Warning': '警報以上',
    'tsunamiOpt.MajorWarning': '僅大海嘯警報',

    'magOpt.3': 'M3.0 以上', 'magOpt.3.5': 'M3.5 以上', 'magOpt.4': 'M4.0 以上',
    'magOpt.4.5': 'M4.5 以上（預設）', 'magOpt.5': 'M5.0 以上', 'magOpt.5.5': 'M5.5 以上',
    'magOpt.6': 'M6.0 以上', 'magOpt.6.5': 'M6.5 以上', 'magOpt.7': 'M7.0 以上',

    'radius.30': '僅本地（約 30 km）',
    'radius.100': '本市及周邊（約 100 km，預設）',
    'radius.300': '較大範圍（約 300 km）'
  },

  ja: {

    'scaleOpt.10': '震度1以上', 'scaleOpt.20': '震度2以上', 'scaleOpt.30': '震度3以上',
    'scaleOpt.40': '震度4以上', 'scaleOpt.45': '震度5弱以上', 'scaleOpt.50': '震度5強以上',
    'scaleOpt.55': '震度6弱以上', 'scaleOpt.60': '震度6強以上', 'scaleOpt.70': '震度7',

    'tsunamiOpt.Watch': '津波注意報以上',
    'tsunamiOpt.Warning': '津波警報以上',
    'tsunamiOpt.MajorWarning': '大津波警報のみ',

    'magOpt.3': 'M3.0 以上', 'magOpt.3.5': 'M3.5 以上', 'magOpt.4': 'M4.0 以上',
    'magOpt.4.5': 'M4.5 以上（既定）', 'magOpt.5': 'M5.0 以上', 'magOpt.5.5': 'M5.5 以上',
    'magOpt.6': 'M6.0 以上', 'magOpt.6.5': 'M6.5 以上', 'magOpt.7': 'M7.0 以上',

    'radius.30': 'ローカルのみ（約 30 km）',
    'radius.100': '市とその周辺（約 100 km、既定）',
    'radius.300': '広い範囲（約 300 km）'
  },

  en: {

    'scaleOpt.10': 'Intensity 1 or higher', 'scaleOpt.20': 'Intensity 2 or higher', 'scaleOpt.30': 'Intensity 3 or higher',
    'scaleOpt.40': 'Intensity 4 or higher', 'scaleOpt.45': 'Intensity 5 lower or higher', 'scaleOpt.50': 'Intensity 5 upper or higher',
    'scaleOpt.55': 'Intensity 6 lower or higher', 'scaleOpt.60': 'Intensity 6 upper or higher', 'scaleOpt.70': 'Intensity 7',

    'tsunamiOpt.Watch': 'Advisory or higher',
    'tsunamiOpt.Warning': 'Warning or higher',
    'tsunamiOpt.MajorWarning': 'Major warning only',

    'magOpt.3': 'M3.0 or higher', 'magOpt.3.5': 'M3.5 or higher', 'magOpt.4': 'M4.0 or higher',
    'magOpt.4.5': 'M4.5 or higher (default)', 'magOpt.5': 'M5.0 or higher', 'magOpt.5.5': 'M5.5 or higher',
    'magOpt.6': 'M6.0 or higher', 'magOpt.6.5': 'M6.5 or higher', 'magOpt.7': 'M7.0 or higher',

    'radius.30': 'Local only (~30 km)',
    'radius.100': 'City and surroundings (~100 km, default)',
    'radius.300': 'Wider area (~300 km)'
  }
}

export { UNITS }
