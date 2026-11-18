// 효과음 + 배경음악(BGM): 파일 없이 Web Audio로 합성 (오프라인에서도 동작, 저작권 걱정 없음).
// 브라우저는 사용자 조작(키·클릭) 없이는 소리를 막는다 → 전시용 크롬은 --autoplay-policy=no-user-gesture-required 로 실행 (README 참고)
export class Sfx {
  constructor() { this.ctx = null; this.master = null; this.bgm = null; this.muted = false; this.log = []; this.bgmMode = 'off'; this._bgmTimer = null; this._step = 0; this._nextT = 0; }

  /** 소리가 실제로 나올 수 있는 상태인가 (브라우저가 사용자 조작 전에는 막음) */
  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  unlock() {
    try {
      if (!this.ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.55;
        this.master.connect(this.ctx.destination);
        this.bgm = this.ctx.createGain(); this.bgm.gain.value = 0; this.bgm.connect(this.master);   // 배경음악 전용 볼륨 (효과음보다 작게)
        this.ctx.onstatechange = () => { if (this.ctx.state === 'running') this._startBgmTimer(); };
        this._bgmGain();                                                                           // 소리가 켜지기 전에 정해진 배경음악 상태를 이어받음
      }
      if (this.ctx.state === 'suspended') { const r = this.ctx.resume(); if (r && r.catch) r.catch(() => {}); }
      this._startBgmTimer();
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

  // ── 배경음악: A단조 4코드(Am F C G) 반복. 'calm' = 패드 + 느린 아르페지오, 'play' = 베이스·비트까지 얹어 힘 있게, 'off' = 조용히 ──
  setBgm(mode) {
    if (mode === this.bgmMode) return;
    this.bgmMode = mode;
    this._bgmGain();
    this._startBgmTimer();
  }

  _bgmGain() {
    if (!this.bgm || !this.ctx) return;
    const t = this.ctx.currentTime, mode = this.bgmMode, target = mode === 'off' ? 0 : mode === 'play' ? 0.34 : 0.24;
    this.bgm.gain.cancelScheduledValues(t);
    this.bgm.gain.setTargetAtTime(target, t, mode === 'off' ? 0.25 : 0.6);                   // 부드럽게 커지고 줄어듦
  }

  _startBgmTimer() {
    if (this._bgmTimer || !this.ctx || typeof setInterval === 'undefined') return;
    this._nextT = this.ctx.currentTime + 0.1; this._step = 0;
    this._bgmTimer = setInterval(() => this._bgmTick(), 80);
  }

  _bgmTick() {
    if (!this.ctx || this.ctx.state !== 'running') { this._nextT = 0; return; }
    const now = this.ctx.currentTime;
    if (!this._nextT || this._nextT < now - 0.5) this._nextT = now + 0.05;
    const BPM = 108, stepDur = 60 / BPM / 2;                                                    // 8분음표
    while (this._nextT < now + 0.4) {
      if (this.bgmMode !== 'off') this._bgmStep(this._step, this._nextT, stepDur);
      this._step = (this._step + 1) % 64; this._nextT += stepDur;
    }
  }

  _bgmStep(step, t, dur) {
    const PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];                      // Am F C G (A3 기준 3화음)
    const bar = Math.floor(step / 8) % 4, pos = step % 8, chord = PROG[bar], hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const play = this.bgmMode === 'play';
    if (pos === 0) chord.forEach((m) => this._bgmNote(hz(m - 12), t, dur * 8, 'triangle', 0.07));            // 패드: 한 마디 길게
    const arp = [0, 1, 2, 1, 2, 1, 0, 1][pos];
    if (play || pos % 2 === 0) this._bgmNote(hz(chord[arp] + 12), t, dur * 1.6, 'triangle', play ? 0.075 : 0.06);   // 아르페지오
    if (play) {
      if (pos === 0 || pos === 3 || pos === 4) this._bgmNote(hz(chord[0] - 24), t, dur * 1.8, 'sine', 0.2);        // 베이스
      if (pos % 2 === 0) this._bgmNote(150, t, 0.1, 'sine', 0.2, 45);                                              // 킥 (주파수가 뚝 떨어지는 사인)
      if (pos % 2 === 1) this._bgmNoise(t, 0.04, 0.05);                                                            // 하이햇
    }
  }

  _bgmNote(freq, t, dur, type, vol, slideTo = null) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.03, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.bgm);
    o.start(t); o.stop(t + dur + 0.03);
  }

  _bgmNoise(t, dur, vol) {
    const n = Math.max(1, Math.floor(this.ctx.sampleRate * dur)), buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource(), hp = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 6000; g.gain.value = vol;
    src.buffer = buf; src.connect(hp); hp.connect(g); g.connect(this.bgm); src.start(t);
  }
}
