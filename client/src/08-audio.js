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
    }
  }
  if (ctx.state === 'suspended') ctx.resume().then(() => { if (ctx.state === 'running') doPlay() }).catch(() => {})
  else doPlay()
}
function playAlertSound(alert, volume) {
  const kind = alert.kind === 'eew' ? 'eew' : (alert.kind === 'tsunami' ? (alert.maxScale >= 3 ? 'tsunami' : 'quake') : 'quake')
  playSound(kind, volume)
}


export { ensureAudio, unlockAudio, playSound, playAlertSound }
