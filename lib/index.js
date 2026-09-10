// Host half of dsh-quake-alert.
//
// M1 时 Host 只是一只空壳：实时链路、解析、匹配、通知、配置存储全在 Client。
// M2（0.2.0）起 Host 承担两件事：
//   1) 注册 settings namespace `quake-alert`（schemastery schema）——配置由 DSH 的
//      settings 服务持久化到机器的 settings.yaml，Client 经 `ctx.settingsScope` 读写。
//      M1 的 localStorage 保留为「无 settings 提供方 / 非 loopback 页面」时的回退与镜像。
//   2) 向 Client 提供市区町村静态表（体积大，不塞进 client bundle）。
//
// 注意：settings 是**可选**依赖——服务不存在时插件必须照常工作（回退 localStorage），
// 因此用 `ctx.inject(['settings'], cb)` 而不是模块级 `export const inject`。

import z from '@deepseek-ai/schemastery'
import { CITIES_BY_PREF } from './data/cities.js'

export const name = 'dsh-quake-alert'

/** Client 拉取市区町村表的只读路由。 */
export const AREAS_PATH = '/dsh-quake-alert/areas'

/** Settings namespace owned by this plugin（小写 + 连字符，符合 settings 服务文法）. */
export const SETTINGS_NAMESPACE = 'quake-alert'

/** 震度档位（P2PQuake scale 数值），与 Client 侧 SCALE_OPTIONS 对齐. */
export const SCALE_VALUES = [10, 20, 30, 40, 45, 50, 55, 60, 70]

/** 海啸等级，与 Client 侧 TSUNAMI_OPTIONS 对齐. */
export const TSUNAMI_GRADES = ['Watch', 'Warning', 'MajorWarning']

/**
 * 持久化配置的 schema。
 *
 * 字段与 Client 侧 DEFAULT_CFG 一一对应：schema 默认值即「用户从未改过」时的解析值，
 * 用户层只记录真正被改写的字段。这里只做类型/范围校验；白名单过滤（例如只保留 47 个
 * 真实县名）仍在 Client 侧做，因为那是用户可见的纠错行为，而不是存储契约。
 */
export const QuakeAlertSettingsSchema = z.object({
  source: z.union(['prod', 'sandbox']).default('prod'),
  watch: z.object({
    // 空 = 关注全日本；两级粒度：都道府县 +（可选）市区町村
    prefectures: z.array(z.string()).default([]),
    cities: z.array(z.string()).default([]),
  }),
  disasters: z.object({
    earthquake: z.boolean().default(true),
    tsunami: z.boolean().default(true),
  }),
  thresholds: z.object({
    quakeScale: z.number().min(0).max(70).default(40),
    eewScale: z.number().min(0).max(70).default(45),
    tsunamiGrade: z.union(TSUNAMI_GRADES).default('Watch'),
  }),
  notify: z.object({
    sound: z.boolean().default(true),
    system: z.boolean().default(true),
    volume: z.number().min(0).max(1).default(0.7),
  }),
  dedupe: z.object({
    windowMinutes: z.number().min(1).max(1440).default(10),
  }),
  quietHours: z.object({
    enabled: z.boolean().default(false),
    start: z.string().default('23:00'),
    end: z.string().default('07:00'),
    breakForSevere: z.boolean().default(true),
  }),
})

/**
 * Register the durable settings namespace when a settings provider is composed,
 * and serve the municipality table to the browser half.
 * Without either service the plugin keeps working (localStorage / prefecture-only).
 *
 * @param ctx - Host context that may acquire the optional settings and webServer services.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, QuakeAlertSettingsSchema)
  })

  // 市区町村表体积大（全国约 1700+ 条），不内联进 client bundle，改由 Host 提供只读 JSON。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: AREAS_PATH,
      handler: (req, res) => {
        try {
          const body = JSON.stringify({ prefectures: CITIES_BY_PREF })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=86400',
          })
          res.end(body)
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: String((err && err.message) || err) }))
        }
      },
    }), 'dsh-quake-alert: /areas route')
  })
}
