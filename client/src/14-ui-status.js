// ============================================================================
// dsh-quake-alert · client/src/14-ui-status.js
//
// 作用：侧边栏底部的连接状态指示（DESIGN 第 6 节）。
// 内容：状态圆点（绿=已连接 / 黄=连接或重连中 / 红=已停止）+ 悬停详情 + 无障碍标签。
// 依赖：01-constants、07-store。
// ============================================================================

import { h, useState, useEffect } from './01-constants.js'
import { store } from './07-store.js'
import { statusMetaOf } from './13-ui-settings.js'

// ---------- 侧边栏状态指示（DESIGN 第 6 节：连接状态显示在插件图标与设置页） ----------
function StatusIndicator(props) {
  const [, setTick] = useState(0)
  useEffect(() => store.subscribe(() => setTick((t) => t + 1)), [])
  const meta = statusMetaOf(store.status, store.retries)
  const wide = Boolean(props && props.wide)
  // 气象警报的「静默提示」（0.3.0）：只有"命中关注地区但未达 L4、没有播报"时才存在
  // （L4 以上播报后会清掉，否则这里会与事实矛盾）。不改颜色、不弹窗、不响铃。
  const hint = store.weatherHint
  const hintText = hint && typeof hint.level === 'number'
    ? ' · 气象警报 L' + hint.level + (hint.label ? '（' + hint.label + '）' : '')
    : ''
  return h('div', {
    role: 'status',
    'aria-label': '灾害预警：' + meta.text + hintText,
    title: '灾害预警：' + meta.text + (store.detail ? ' · ' + store.detail : '') + hintText,
    style: { display: 'flex', alignItems: 'center', gap: 6, padding: wide ? '4px 8px' : '4px', fontSize: 12, color: 'inherit', cursor: 'default' },
  },
    h('span', { style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: meta.color, flex: '0 0 auto' } }),
    wide ? h('span', { style: { whiteSpace: 'nowrap' } }, '灾害预警') : null)
}


export { StatusIndicator }
