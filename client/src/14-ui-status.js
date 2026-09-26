// ============================================================================
// dsh-quake-alert · client/src/14-ui-status.js
//
// 作用：侧边栏底部的连接状态指示（DESIGN 第 6 节）。
// 内容：状态圆点（绿=已连接 / 黄=连接或重连中 / 红=已停止）+ 悬停详情 + 无障碍标签。
// 依赖：01-constants、07-store、00-i18n。
// ============================================================================

import { h, useState, useEffect } from './01-constants.js'
import { t } from './00-i18n.js'
import { store } from './07-store.js'
import { statusMetaOf } from './13-ui-settings.js'

// ---------- 侧边栏状态指示（DESIGN 第 6 节：连接状态显示在插件图标与设置页） ----------
function StatusIndicator(props) {
  const [, setTick] = useState(0)
  useEffect(() => store.subscribe(() => setTick((t) => t + 1)), [])
  const meta = statusMetaOf(store.status, store.retries)
  const wide = Boolean(props && props.wide)
  // disabled（用户关掉了某个灾种 / 全部关掉）用**空心**圆点表示，与 stale / 未启动 的实心灰区分开
  // （DESIGN 5 节的六态表格）。轮廓是边框而非填充，深色主题下也不会消失。
  const dotStyle = store.status === 'disabled'
    ? { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'transparent', border: '1.5px solid ' + meta.color, flex: '0 0 auto' }
    : { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: meta.color, flex: '0 0 auto' }
  // 气象警报的「静默提示」（0.3.0）：只有"命中关注地区但未达 L4、没有播报"时才存在
  // （L4 以上播报后会清掉，否则这里会与事实矛盾）。不改颜色、不弹窗、不响铃。
  const hint = store.weatherHint
  const hintText = hint && typeof hint.level === 'number'
    ? t('status.weatherHint', { level: hint.level }) + (hint.label ? t('status.weatherHintLabel', { label: hint.label }) : '')
    : ''
  return h('div', {
    role: 'status',
    'aria-label': t('app.statusPrefix') + meta.text + hintText,
    title: t('app.statusPrefix') + meta.text + (store.detail ? ' · ' + store.detail : '') + hintText,
    style: { display: 'flex', alignItems: 'center', gap: 6, padding: wide ? '4px 8px' : '4px', fontSize: 12, color: 'inherit', cursor: 'default' },
  },
    h('span', { style: dotStyle }),
    wide ? h('span', { style: { whiteSpace: 'nowrap' } }, t('app.name')) : null)
}


export { StatusIndicator }
