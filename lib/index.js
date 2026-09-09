// Host half of dsh-quake-alert.
//
// M1：实时链路与配置存储都在浏览器端（Client 直连 P2PQuake WebSocket，
// 配置持久化于 localStorage），Host 半边保持最小壳以便插件行正常装载。
//
// M2（机器级持久化）：在此注册 settings 命名空间（zod schema），
// Client 经 @Remote 读写 settings.yaml —— 已在 DESIGN.md 第 8 节记录。

export const name = 'dsh-quake-alert'

export function apply(ctx) {
  // M1 无 Host 逻辑；占位避免空实现歧义。
  ctx.on('dispose', () => {})
}
