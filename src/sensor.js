// 입력 모듈: 가상 손의 3D 위치와 쥠(grab) 상태를 제공
//  - HandSensor : 서버 손 인식(깊이 카메라 + MediaPipe) 스트림 /hand → 화면 위치 + 깊이 + 쥠
//  - MouseSensor: 마우스 위치 = 손 X·Y, 휠·W/S = 앞뒤(Z), 왼쪽 버튼 누름 = 쥠
//  - InputManager: 손이 보이면 손, 아니면 마우스
// 둘 다 같은 방식으로 3D 위치를 정함: 화면 위치(ndc)에서 카메라 광선을 쏴 z = 깊이 평면과 만나는 점
import * as THREE from 'three';

export const HAND_BOUNDS = { x: [-3.2, 3.2], y: [0.05, 40], z: [-1.6, 1.6] };
const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));

const _ray = new THREE.Raycaster();
const _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
function rayToPlane(camera, ndc, z, out) {
  _plane.constant = -z;
  _ray.setFromCamera(ndc, camera);
  const hit = _ray.ray.intersectPlane(_plane, out);
  if (hit) out.set(clamp(hit.x, HAND_BOUNDS.x), clamp(hit.y, HAND_BOUNDS.y), z);
  return out;
}

export class MouseSensor {
  constructor(canvas, camera) {
    this.source = 'mouse';
    this.camera = camera;
    this.ndc = new THREE.Vector2(0, -0.2);
    this.z = 0.4;
    this.grab = false;
    this.visible = false;
    this._pos = new THREE.Vector3();

    window.addEventListener('pointermove', (e) => {
      this.ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      this.visible = true;
    });
    canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) this.grab = true; });
    window.addEventListener('pointerup', (e) => { if (e.button === 0) this.grab = false; });
    window.addEventListener('blur', () => { this.grab = false; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.z = clamp(this.z + Math.sign(e.deltaY) * 0.15, HAND_BOUNDS.z);
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyW') this.z = clamp(this.z - 0.15, HAND_BOUNDS.z);
      if (e.code === 'KeyS') this.z = clamp(this.z + 0.15, HAND_BOUNDS.z);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  read() {
    rayToPlane(this.camera, this.ndc, this.z, this._pos);
    return { pos: this._pos, grab: this.grab, visible: this.visible, ndc: this.ndc };
  }
}

// One Euro 필터: 천천히 움직일 땐 떨림을 강하게 줄이고, 빠르게 움직일 땐 지연을 줄임
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff }); this.reset(); }
  reset() { this.t = null; }
  filter(x, t) {
    if (this.t === null) { this.t = t; this.x = x; this.dx = 0; return x; }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const alpha = (cutoff) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.dx += alpha(this.dCutoff) * ((x - this.x) / dt - this.dx);
    this.x += alpha(this.minCutoff + this.beta * Math.abs(this.dx)) * (x - this.x);
    return this.x;
  }
}

const HOLD_LOST_MS = 400;      // 손을 잠깐 놓쳐도 이 시간 동안은 마지막 상태 유지 (블록을 떨어뜨리지 않게)
const STALE_MS = 1500;         // 서버 소식이 이만큼 없으면 손 인식 끊김

export class HandSensor {
  constructor(camera, connect = true) {
    this.source = 'hand';
    this.camera = camera;
    this.info = { available: false };
    this.ndc = new THREE.Vector2();
    this.z = 0;
    this.grab = false;
    this.lastSeen = -1e9;
    this.lastMsg = -1e9;
    this.depthRef = null;          // 카운트다운 때 잰 손 거리 (없으면 서버 설정값)
    this._calib = null;
    this._pos = new THREE.Vector3();
    this._fx = new OneEuro(1.2, 0.8);
    this._fy = new OneEuro(1.2, 0.8);
    this._fd = new OneEuro(0.8, 0.5);
    if (connect) this._connect();
  }

  _connect() {
    const es = new EventSource('/hand');
    es.onmessage = (e) => this._onData(JSON.parse(e.data));
    es.onerror = () => { this.info = { available: false, error: '서버 연결 끊김' }; };   // EventSource가 알아서 다시 연결
  }

  _onData(s) {
    const now = performance.now();
    this.lastMsg = now;
    this.info = s;
    if (!s.available || !s.visible) return;
    if (now - this.lastSeen > HOLD_LOST_MS) { this._fx.reset(); this._fy.reset(); this._fd.reset(); }
    const t = now / 1000;
    this.ndc.set(clamp(this._fx.filter(s.nx, t), [-1.05, 1.05]), clamp(this._fy.filter(s.ny, t), [-1.05, 1.05]));
    const d = this._fd.filter(s.d, t);
    if (this._calib) this._calib.push(s.d);
    // 손을 카메라 쪽(화면 쪽)으로 내밀수록 거리가 줄고 → 장면 안쪽(-z)으로
    const ref = this.depthRef ?? s.depth_ref;
    this.z = clamp((d - ref) / s.depth_range * HAND_BOUNDS.z[1], HAND_BOUNDS.z);
    this.grab = !!s.grab;
    this.lastSeen = now;
  }

  get available() { return !!this.info.available && performance.now() - this.lastMsg < STALE_MS; }

  read() {
    const visible = this.available && performance.now() - this.lastSeen < HOLD_LOST_MS;
    if (visible) rayToPlane(this.camera, this.ndc, this.z, this._pos);
    return { pos: this._pos, grab: visible && this.grab, visible, ndc: this.ndc };
  }

  // 게임 시작 카운트다운 동안 손 거리를 모아 앞뒤 기준(가운데)으로 삼음
  startCalibration() { this._calib = []; }
  finishCalibration() {
    const c = this._calib;
    this._calib = null;
    if (c && c.length >= 5) this.depthRef = [...c].sort((a, b) => a - b)[Math.floor(c.length / 2)];
  }
}

export class InputManager {
  // useHand=false: 손 인식 스트림에 연결하지 않음 (헤드리스 테스트는 열린 스트림 때문에 가상 시간이 멈춤)
  constructor(canvas, camera, useHand = true) {
    this.mouse = new MouseSensor(canvas, camera);
    this.hand = new HandSensor(camera, useHand);
    this.source = 'mouse';
  }

  read() {
    const h = this.hand.read();
    if (h.visible) { this.source = 'hand'; return h; }
    this.source = 'mouse';
    return this.mouse.read();
  }
}
