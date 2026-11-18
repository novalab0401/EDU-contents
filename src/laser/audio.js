// 효과음: 파일 없이 Web Audio로 합성 (오프라인에서도 동작).
// 브라우저는 사용자 조작(키·클릭) 없이는 소리를 막는다 → 전시용 크롬은 --autoplay-policy=no-user-gesture-required 로 실행 (README 참고)
export class Sfx {
  constructor() { this.ctx = null; this.master = null; this.muted = false; this.log = []; }

  unlock() {
    try {
      if (!this.ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.55;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* 소리가 안 나도 게임은 계속 */ }
  }

  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.55; }

  _tone(freq, dur = 0.15, type = 'sine', vol = 0.22, slideTo = null, delay = 0) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  _note(name) { this.log.push(name); if (this.log.length > 50) this.log.shift(); }

  fire() { this._note('fire'); this._tone(1500, 0.3, 'sawtooth', 0.14, 160); this._tone(110, 0.22, 'square', 0.1, 40); }
  bounce(i = 0) { this._note('bounce'); this._tone(820 + i * 130, 0.07, 'triangle', 0.1); }
  hit(order = 0) {
    this._note('hit' + order);
    const f = [660, 880, 1175, 1480][Math.min(order, 3)];
    this._tone(f, 0.32, 'sine', 0.26); this._tone(f * 1.5, 0.28, 'sine', 0.12, null, 0.05);
  }
  wrong() { this._note('wrong'); this._tone(190, 0.22, 'square', 0.12, 120); }
  miss() { this._note('miss'); this._tone(320, 0.25, 'triangle', 0.14, 160); }
  tick() { this._note('tick'); this._tone(1000, 0.06, 'square', 0.08); }
  go() { this._note('go'); this._tone(1500, 0.3, 'square', 0.1, 2200); }
  select() { this._note('select'); this._tone(700, 0.05, 'triangle', 0.07); }
  win() { this._note('win'); [523, 659, 784, 1047, 1319].forEach((f, i) => this._tone(f, 0.25, 'triangle', 0.2, null, i * 0.1)); }
  lose() { this._note('lose'); [440, 370, 311, 247].forEach((f, i) => this._tone(f, 0.3, 'triangle', 0.16, null, i * 0.14)); }
  star() { this._note('star'); this._tone(1568, 0.25, 'sine', 0.18); }
}
