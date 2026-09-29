// ============================================================================
// dsh-quake-alert · client/src/08-audio.js
// 作用：提示音合成（Web Audio，零音频文件）——AudioContext 懒创建与解锁、按灾害类型选音色播放。
// 依赖：01-constants。浏览器要求 AudioContext 先经一次用户交互才能出声，故有 unlock 逻辑。
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
/** 当前音频可用状态：'running' | 'suspended' | 'unavailable'，设置页据此提示尚未解锁。 */
function audioState() {
  // 不能调用 ensureAudio()：它真的会 new AudioContext，设置页渲染读本函数时会在无用户手势的
  // 情况下创建音频上下文。未创建同样属于"未解锁"，按 suspended 回答。
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
  // 气象警报（泥石流 / 洪水 / 大雨 / 高潮）：下行三音 + triangle 波形，与地震 / EEW / 海啸区分开
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
    // 播完断开：osc.stop() 只是停止发声，节点仍挂在 destination 上，长期运行会一直累积
    setTimeout(() => {
      for (const node of nodes) { try { node.disconnect() } catch (err) { /* 已断开等忽略 */ } }
      try { master.disconnect() } catch (err) { /* 忽略 */ }
    }, Math.ceil((endAt + 0.3) * 1000))
  }
  if (ctx.state === 'suspended') ctx.resume().then(() => { if (ctx.state === 'running') doPlay() }).catch(() => {})
  else doPlay()
}
/** 按灾害类型选音色（纯函数，便于断言气象不再沿用地震音）。 */
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
/**
 * 这条提醒该不该**发声**：`notify.sound` 是总开关，三个分开关按**灾害种类**（`alert.kind`）细分
 * ——地震（含 EEW）/ 海啸 / 气象；认不出的 kind（测试音等）只看总开关。
 *
 * 按 kind 直接分派，**不要**改成复用 `soundKindOf`：那个函数回答的是"听起来像什么"，而海啸会按
 * 档位借用地震音色，复用它会把 rank 1 / 2 的海啸（津波注意報 / 津波警報）算进地震开关。
 */
function soundAllowedFor(cfg, alert) {
  const n = (cfg && cfg.notify) || {}
  if (n.sound === false) return false
  if (!alert) return true
  if (alert.kind === 'eew' || alert.kind === 'quake') return n.soundQuake !== false
  if (alert.kind === 'tsunami') return n.soundTsunami !== false
  if (alert.kind === 'weather') return n.soundWeather !== false
  return true
}


export { ensureAudio, unlockAudio, audioState, playSound, playAlertSound, soundKindOf, soundAllowedFor, SOUNDS }
