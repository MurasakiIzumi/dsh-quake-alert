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
  return h('div', {
    role: 'status',
    'aria-label': '灾害预警：' + meta.text,
    title: '灾害预警：' + meta.text + (store.detail ? ' · ' + store.detail : ''),
    style: { display: 'flex', alignItems: 'center', gap: 6, padding: wide ? '4px 8px' : '4px', fontSize: 12, color: 'inherit', cursor: 'default' },
  },
    h('span', { style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: meta.color, flex: '0 0 auto' } }),
    wide ? h('span', { style: { whiteSpace: 'nowrap' } }, '灾害预警') : null)
}


export { StatusIndicator }
