// 레이저 챌린지 입력: 손 기울기 → 거울 각도, 주먹 → 발사. (손이 없으면 마우스·키보드로도 가능)
//
//  손 인식 스트림 /hand 의 hands 목록(화면 왼쪽부터)을 받아서
//   - 손 거울(H1=왼쪽 거울, H2=오른쪽 거울)에 손을 나눠 줌 (손 2개 → 왼손=H1·오른손=H2 / 손 1개 → 왼쪽에 있으면 H1, 오른쪽이면 H2)
//   - 손가락이 가리키는 선의 기울기를 부드럽게 만든 뒤 SNAP(5°) 단위로 끊음 (경계에서 깜빡이지 않게 히스테리시스)
//   - 주먹을 쥐는 순간 발사. 주먹을 쥐면서 각도가 흐트러지므로 쥐기 직전(약 0.3초 전) 각도로 고정
//  손이 사라지면 마지막 각도를 유지하고 tracked=false (게임이 "손을 보여주세요"를 띄움)
import { SNAP, snapAngle } from './levels.js';
import { lineDiff, norm180, deg } from './optics.js';

const LOST_MS = 600;          // 손을 이만큼 못 보면 tracked=false (각도는 유지)
const STALE_MS = 1500;        // 서버 소식이 이만큼 없으면 손 인식 끊김
const ANGLE_TAU = 0.07;       // 각도 평활 시간상수 (초)
const HYST = 1.2;             // 스냅 경계에서 이만큼(°) 더 넘어야 바뀜
const FREEZE_BACK = 0.30;     // 주먹 쥘 때 이 시간(초) 전 각도로 되돌림
const FIRE_COOLDOWN = 0.7;    // 연속 발사 방지 (초)
const SIDE_NX = 0.12;         // 손 하나일 때 좌/우 구분 경계 (가운데 ±이 안은 직전 선택 유지)

const mkSlot = () => ({ angle: 90, raw: 90, tracked: false, hasEver: false, fist: false, lastSeen: -1e9, filt: null, hist: [], frozen: false });

export class LaserInput {
  /** clock: () => 초 (테스트에서는 가상 시간) */
  constructor({ useHand = true, clock = () => performance.now() / 1000, onFire = () => {} } = {}) {
    this.clock = clock;
    this.onFire = onFire;
    this.ids = ['H1'];
    this.slots = { H1: mkSlot(), H2: mkSlot() };
    this.active = 'H1';                // 키보드·마우스로 돌리는 거울
    this.info = { available: false };
    this.handsVisible = 0;
    this.lastMsg = -1e9;
    this.lastFire = -1e9;
    this.lastSingle = null;
    this.source = 'mouse';             // 'hand' | 'mouse'
    this.handSeenAt = -1e9;
    if (useHand && typeof EventSource !== 'undefined') this._connect();
  }

  _connect() {
    const es = new EventSource('/hand');
    es.onmessage = (e) => { try { this.onData(JSON.parse(e.data)); } catch { /* 깨진 메시지는 무시 */ } };
    es.onerror = () => { this.info = { available: false, error: '서버 연결 끊김' }; };   // EventSource가 알아서 다시 연결
  }

  /** 레벨이 바뀔 때: 어떤 손 거울이 있는지, 시작 각도 */
  setLevel(scene) {
    this.ids = scene.mirrors.filter((m) => m.kind === 'hand').map((m) => m.id);
    for (const id of ['H1', 'H2']) {
      const m = scene.mirrors.find((x) => x.id === id);
      Object.assign(this.slots[id], mkSlot(), { angle: m ? m.angle : 90, raw: m ? m.angle : 90 });
    }
    this.active = this.ids[0];
    this.lastSingle = null;
  }

  get available() { return !!this.info.available && (this.clock() - this.lastMsg) * 1000 < STALE_MS; }
  get handActive() { return this.available && (this.clock() - this.handSeenAt) * 1000 < LOST_MS; }
  get anyTracked() { return this.ids.some((id) => this.slots[id].tracked); }

  /** /hand 메시지 하나 (서버 약 30fps) */
  onData(s) {
    const t = this.clock();
    this.lastMsg = t;
    this.info = s;
    const hands = Array.isArray(s.hands) ? s.hands : (s.available && s.visible ? [{ nx: s.nx, ny: s.ny, ang: null, fist: !!s.grab }] : []);
    this.handsVisible = s.available ? hands.length : 0;
    if (!s.available || !hands.length) return;
    this.handSeenAt = t;
    this.source = 'hand';
    const map = this._assign(hands);
    hands.forEach((h, i) => { if (map[i]) this._feed(map[i], h, t); });
  }

  /** 손 → 거울 배정 (hands는 화면 왼쪽부터) */
  _assign(hands) {
    const ids = this.ids;
    if (ids.length <= 1) return [ids[0]];                      // 거울이 하나면 첫 번째 손
    if (hands.length >= 2) return [ids[0], ids[1]];            // 두 손: 왼손 = H1, 오른손 = H2
    const nx = hands[0].nx;
    let id = this.lastSingle;
    if (nx < -SIDE_NX) id = ids[0]; else if (nx > SIDE_NX) id = ids[1]; else if (!id) id = nx < 0 ? ids[0] : ids[1];
    this.lastSingle = id;
    return [id];
  }

  _feed(id, h, t) {
    const sl = this.slots[id];
    sl.tracked = true; sl.hasEver = true; sl.lastSeen = t;
    // 쥠: 새로 쥐는 순간 → 쥐기 직전 각도로 고정 + 발사
    const wasFist = sl.fist;
    sl.fist = !!h.fist;
    if (sl.fist && !wasFist && sl.hist.length) {
      const back = sl.hist.findLast ? sl.hist.findLast((p) => p.t <= t - FREEZE_BACK) : null;
      const pick = back || sl.hist[0];
      sl.raw = pick.raw;
      sl.angle = snapAngle(pick.raw);
      sl.frozen = true;
      this._fire(id, 'fist');
    }
    if (!sl.fist) sl.frozen = false;
    if (sl.frozen || typeof h.ang !== 'number') return;
    // 각도: 180° 주기라서 (cos2θ, sin2θ) 벡터로 평활
    const a2 = (h.ang * Math.PI) / 90;
    const c = Math.cos(a2), s = Math.sin(a2);
    if (!sl.filt) sl.filt = { c, s, t };
    else {
      const k = 1 - Math.exp(-Math.max(1e-3, t - sl.filt.t) / ANGLE_TAU);
      sl.filt.c += k * (c - sl.filt.c); sl.filt.s += k * (s - sl.filt.s); sl.filt.t = t;
    }
    sl.raw = norm180(deg(Math.atan2(sl.filt.s, sl.filt.c)) / 2);
    sl.hist.push({ t, raw: sl.raw });
    while (sl.hist.length && sl.hist[0].t < t - 1.0) sl.hist.shift();
    if (Math.abs(lineDiff(sl.raw, sl.angle)) > SNAP / 2 + HYST) sl.angle = snapAngle(sl.raw);   // 히스테리시스
  }

  _fire(id, via) {
    const t = this.clock();
    if (t - this.lastFire < FIRE_COOLDOWN) return;
    this.lastFire = t;
    this.onFire({ slot: id, via });
  }

  /** 매 프레임: 손을 놓친 거울 표시 */
  update() {
    const t = this.clock();
    for (const id of ['H1', 'H2']) {
      const sl = this.slots[id];
      if (sl.tracked && (t - sl.lastSeen) * 1000 > LOST_MS) { sl.tracked = false; sl.fist = false; sl.frozen = false; sl.filt = null; sl.hist = []; }
    }
    if (!this.handActive) this.source = 'mouse';
  }

  // ── 마우스·키보드 (손 인식이 없거나 운영자가 직접 조작할 때) ──
  rotate(id, steps) {
    const sl = this.slots[id];
    if (!sl) return;
    sl.angle = norm180(sl.angle + steps * SNAP);
    sl.raw = sl.angle;
    this.source = this.handActive ? 'hand' : 'mouse';
  }
  select(id) { if (this.ids.includes(id)) this.active = id; }
  cycle() { const i = this.ids.indexOf(this.active); this.active = this.ids[(i + 1) % this.ids.length]; }
  manualFire() { this._fire(this.active, 'key'); }

  bind(canvas) {
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      const k = e.code;
      if (k === 'ArrowLeft' || k === 'KeyA' || k === 'KeyQ') this.rotate(this.active, +1);      // 반시계
      else if (k === 'ArrowRight' || k === 'KeyD' || k === 'KeyE') this.rotate(this.active, -1);  // 시계
      else if (k === 'Tab') { e.preventDefault(); this.cycle(); }
      else if (k === 'Digit1' && !e.shiftKey) this.select('H1');
      else if (k === 'Digit2') this.select('H2');
      else if (k === 'Space') { e.preventDefault(); this.manualFire(); }
    });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.rotate(this.active, e.deltaY < 0 ? 1 : -1); }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) this.manualFire(); else if (e.button === 2) this.cycle(); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
