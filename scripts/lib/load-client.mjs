// dsh-quake-alert · 在 Node 里加载客户端 bundle（契约脚本与回归测试共用的约定）
//
// 作用：stub 掉浏览器的 `window.__ModuleLoader__`，在 vm 沙箱里执行**已提交的**
//       `client/client.js`，取回它的 `exports`（也就是 `__test` 那个纯函数导出面）。
//
// 为什么不与 `tests/sync-test.cjs` 顶部那一份合并：
//   那边除了取 `__test`，还要注入假 WebSocket / 假定时器去驱动连接生命周期用例
//   （`harness` / `makeSched` / `makeSocket`），合并会把「取纯函数」与「搭一个受控的假环境」
//   两个用途绑死——而契约脚本只需要前者（DESIGN 11.9 E：拉真实数据、交给解析器、看它还认不认）。
//   两份都建立在同一个约定上：`client/client.js` 是**单文件** bundle、`__test` 是**导出面**。
//   任何一边失效（bundle 没构建、`__test` 改名、单文件假设被打破），另一边会立刻红
//   ——约定本身因此是被两边共同守护的。
//
// 注意读的是**已提交的构建产物**而不是现场构建：CI 上不需要 pnpm、不需要 rollup，
// 而"提交的 bundle 与 client/src/ 不同步"这件事由 `node scripts/build-client.mjs --check`
// 单独负责（两件事分开，失败原因才不会混在一起）。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 已提交的构建产物路径（导出是为了让调用方能在报错里指出它在哪）。 */
export const CLIENT_PATH = path.join(ROOT, 'client', 'client.js')

// 文件内容读一次即可：同一个进程里它不会变。「模拟页面重载」指的是**重新执行**沙箱
// （见 loadClientEx），不是重新读盘。
let clientCode = null
function codeOf() {
  if (clientCode === null) {
    try {
      clientCode = readFileSync(CLIENT_PATH, 'utf8')
    } catch (err) {
      throw new Error('读不到 ' + CLIENT_PATH + '（client bundle 未构建？先跑 node scripts/build-client.mjs）')
    }
  }
  return clientCode
}

/**
 * 在 vm 沙箱里执行一遍 client.js，返回它的 exports 与本次的 localStorage 后备存储。
 *
 * 每次调用都是**全新沙箱 + 全新执行**，所以模块级的 `let`（表状态、健康记录、注册表）都从
 * 初始状态开始——这正是"模拟页面刷新"需要的语义。
 *
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.storage] 预置的 localStorage 内容（键值对）
 * @param {object} [opts.window] window 的覆盖项（注入假 WebSocket / document / fetch 等）
 * @param {object} [opts.react] react stub：默认空对象（parse/match 不渲染 React）；
 *   需要真的渲染 UI 的用例传一个极简实现进来
 * @param {Function} [opts.setTimeout]
 * @param {Function} [opts.clearTimeout]
 * @returns {{ exports: object, storage: Map<string, string> }}
 */
export function loadClientEx(opts) {
  const o = opts || {}
  const memStore = new Map(Object.entries(o.storage || {}))
  const windowStub = Object.assign({
    localStorage: {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => memStore.set(k, String(v)),
      removeItem: (k) => memStore.delete(k),
    },
    AudioContext: undefined,
    WebSocket: undefined,
    Notification: undefined,
    document: undefined,
    addEventListener() {},
    removeEventListener() {},
  }, o.window || {})
  const sandbox = {
    window: windowStub,
    console,
    setTimeout: o.setTimeout || setTimeout,
    clearTimeout: o.clearTimeout || clearTimeout,
  }
  // client.js 的 handleRaw 用裸 `document` 判断页面可见性（浏览器里就是 window.document），
  // 注入 document 的用例需要把它同时挂到沙箱全局，否则永远走「后台」分支。
  if (windowStub.document) sandbox.document = windowStub.document
  sandbox.window.window = sandbox.window
  windowStub.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      sandbox.__exports = factory((req) => (req === 'react' ? (o.react || {}) : undefined))
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(codeOf(), sandbox, { filename: 'client.js' })
  if (!sandbox.__exports) {
    throw new Error('client.js 没有通过 window.__ModuleLoader__ 注册模块（单文件 bundle 的形态变了？）')
  }
  return { exports: sandbox.__exports, storage: memStore }
}

/**
 * 只取 exports，并**当场检查导出面**：`__test` 是两份脚本唯一的入口，缺了就该立刻失败并说清
 * 是"导出面变了"，而不是让调用方在 `undefined.parseXxx` 上炸掉、把一个命名问题读成解析问题。
 * @param {object} [opts] 同 loadClientEx
 * @returns {object} client.js 的 exports
 */
export function loadClient(opts) {
  const { exports } = loadClientEx(opts)
  if (!exports.__test) {
    throw new Error('client.js 的 exports 里没有 __test（导出面变了？见 client/src/15-entry.js 末尾）')
  }
  return exports
}
