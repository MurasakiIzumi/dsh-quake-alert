// ============================================================================
// dsh-quake-alert · client/src/08-audio.js
//
// 作用：提示音合成（Web Audio，零音频文件）。
// 内容：AudioContext 懒创建与用户手势解锁、四种音色（地震/EEW/海啸/取消）、
//       按灾害类型选音色并播放。
// 依赖：01-constants。
// 浏览器策略：AudioContext 需要一次用户交互才能出声，故有 unlock 逻辑。
// ============================================================================

// ---------- 音频（Web Audio 合成，零文件） ----------
let audioCtx = null
function ensureAudio() {
  if (audioCtx === null && typeof window !== 'undefined') {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (Ctor) { try { audioCtx = new Ctor() } catch (err) { audioCtx = null } }
  }
  return audioCtx
}
function unlockAudio() {
  const ctx = ensureAudio()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
}
/**
 * 当前音频可用状态（0.4.1）：'running' | 'suspended' | 'unavailable'。
 *
 * 为什么需要它：浏览器要求 AudioContext 必须先有一次用户交互才能出声，而**页面可见时
 * 通知路径只用页内 toast（不发系统通知）**。于是"打开 DSH 后从未点击过页面"的用户
 * 在设置里看到「提示音：开」，实际一条声音都听不到，且没有任何地方能发现这件事——
 * 这是纯静默失效。设置页据此显式提示"提示音尚未解锁"。
 */
function audioState() {
  // 注意：**不能调用 ensureAudio()**（0.4.2）。设置页在渲染时会读这个函数，而 ensureAudio 会
  // 真的 new 一个 AudioContext —— 于是"只是打开设置页"就创建了音频上下文（浏览器控制台会报
  // "AudioContext was not allowed to start"），也破坏了"只在用户手势里创建"的设计。
  // 未创建同样属于"未解锁"，直接按 suspended 回答。
  if (typeof window !== 'undefined' && !(window.AudioContext || window.webkitAudioContext)) return 'unavailable'
  if (audioCtx === null) return 'suspended'
  return audioCtx.state === 'running' ? 'running' : 'suspended'
}
// 音色描述：notes 列表（freq Hz / start s / dur s / type）
const SOUNDS = {
  eew: { notes: [
    { freq: 932, start: 0, dur: 0.12, type: 'square' },
    { freq: 932, start: 0.22, dur: 0.12, type: 'square' },
    { freq: 1244, start: 0.44, dur: 0.5, type: 'square' },
  ] },
  tsunami: { notes: [
    { freq: 196, start: 0, dur: 0.9, type: 'sawtooth' },
    { freq: 147, start: 0.7, dur: 1.1, type: 'sawtooth' },
  ] },
  quake: { notes: [
    { freq: 659, start: 0, dur: 0.18, type: 'sine' },
    { freq: 880, start: 0.2, dur: 0.3, type: 'sine' },
  ] },
  // 气象警报（泥石流 / 洪水 / 大雨 / 高潮）：下行三音 + triangle 波形。
  // 与地震（上行双音 sine）、EEW（急促方波）、海啸（低频长音 sawtooth）都区分开——
  // 气象灾害与地震的应对方式不同，不该共用一个音色。
  weather: { notes: [
    { freq: 587, start: 0, dur: 0.22, type: 'triangle' },
    { freq: 494, start: 0.26, dur: 0.22, type: 'triangle' },
    { freq: 392, start: 0.52, dur: 0.6, type: 'triangle' },
  ] },
  // 取消 / 解除：下行音，与「警报」区分开
  cancel: { notes: [
    { freq: 880, start: 0, dur: 0.16, type: 'sine' },
    { freq: 659, start: 0.18, dur: 0.34, type: 'sine' },
  ] },
  test: { notes: [
    { freq: 784, start: 0, dur: 0.16, type: 'sine' },
    { freq: 1046, start: 0.18, dur: 0.3, type: 'sine' },
  ] },
}
function playSound(kind, volume) {
  const preset = SOUNDS[kind] || SOUNDS.test
  const ctx = ensureAudio()
  if (!ctx) return
  const vol = typeof volume === 'number' && volume >= 0 && volume <= 1 ? volume : 0.7
  const doPlay = () => {
    const master = ctx.createGain()
    master.gain.value = vol * 0.5
    master.connect(ctx.destination)
    const t0 = ctx.currentTime
    const nodes = [] // 这次播放创建的所有节点，播完统一断开
    let endAt = 0
    for (const n of preset.notes) {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = n.type || 'sine'
      osc.frequency.value = n.freq
      const start = t0 + n.start
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime(1, start + 0.02)
      g.gain.setValueAtTime(1, start + n.dur - 0.08)
      g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur)
      osc.connect(g); g.connect(master)
      osc.start(start); osc.stop(start + n.dur + 0.05)
      nodes.push(osc, g)
      if (n.start + n.dur > endAt) endAt = n.start + n.dur
    }
    // 播完断开：osc.stop() 只是停止发声，节点仍挂在 destination 上；
    // 每次警报都新建 2～3 个节点，长期运行会一直累积（disconnect 后交给 GC）。
    setTimeout(() => {
      for (const node of nodes) { try { node.disconnect() } catch (err) { /* 已断开等忽略 */ } }
      try { master.disconnect() } catch (err) { /* 忽略 */ }
    }, Math.ceil((endAt + 0.3) * 1000))
  }
  if (ctx.state === 'suspended') ctx.resume().then(() => { if (ctx.state === 'running') doPlay() }).catch(() => {})
  else doPlay()
}
/** 按灾害类型选音色（抽成纯函数，便于断言"气象不再沿用地震音"）。 */
function soundKindOf(alert) {
  if (!alert) return 'test'
  if (alert.kind === 'eew') return 'eew'
  if (alert.kind === 'tsunami') return alert.maxScale >= 3 ? 'tsunami' : 'quake'
  if (alert.kind === 'weather') return 'weather'
  return 'quake'
}
function playAlertSound(alert, volume) {
  playSound(soundKindOf(alert), volume)
}


export { ensureAudio, unlockAudio, audioState, playSound, playAlertSound, soundKindOf, SOUNDS }
