// 브라우저 안 손 인식: 웹캠(getUserMedia) + MediaPipe Tasks Vision(WASM).
// 파이썬 서버·opencv가 필요 없어서 윈도우 보안 정책으로 DLL이 막힌 PC에서도, 설치 없이 크롬만으로 돌아갑니다.
// 손 계산은 handmath.js (hand.py와 같은 규칙) → 서버 /hand 메시지와 같은 모양으로 onData에 전달.
import { candidates, FistTracker, buildMessage, BONES } from './handmath.js';

const BUNDLE = '/vendor/mediapipe/vision_bundle.mjs';
const WASM_DIR = '/vendor/mediapipe/wasm';
const MODEL_LOCAL = '/models/hand_landmarker.task';
const MODEL_REMOTE = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const MIN_MODEL_BYTES = 1_000_000;   // 오류 페이지(수백 바이트)가 모델 파일로 저장된 경우를 걸러냄

export class WebHand {
  constructor({ onData, onStatus = () => {} }) {
    this.onData = onData; this.onStatus = onStatus;
    this.status = { state: 'idle', msg: '', fps: 0, delegate: '-', model: '-' };
    this.video = null; this.stream = null; this.lm = null;
    this.fists = new FistTracker();
    this.times = []; this.lastTime = -1; this.lastTs = 0; this.running = false;
    this.preview = null; this.last = { cands: [], result: null };
  }

  _set(state, msg = '', extra = {}) {
    this.status = { ...this.status, ...extra, state, msg };
    this.onStatus(this.status);
  }

  async _model(skipLocal = false) {
    try {
      const r = skipLocal ? { ok: false } : await fetch(MODEL_LOCAL);
      if (r.ok) {
        const b = await r.arrayBuffer();
        if (b.byteLength >= MIN_MODEL_BYTES) { this.status.model = 'local'; return new Uint8Array(b); }
      }
    } catch { /* 아래에서 인터넷으로 */ }
    try {
      const r = await fetch(MODEL_REMOTE);
      if (r.ok) {
        const b = await r.arrayBuffer();
        if (b.byteLength >= MIN_MODEL_BYTES) { this.status.model = 'internet'; return new Uint8Array(b); }
      }
    } catch { /* 실패 */ }
    throw new Error('손 인식 모델(models/hand_landmarker.task)을 찾지 못했어요');
  }

  async _create(vision, buf, delegate) {
    return vision.HandLandmarker.createFromOptions(await vision.FilesetResolver.forVisionTasks(WASM_DIR), {
      baseOptions: { modelAssetBuffer: buf, delegate },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._set('error', '이 주소에서는 브라우저 카메라를 쓸 수 없어요 — http://localhost:8001/laser 로 여세요');
      throw new Error('no getUserMedia');
    }
    try {
      this._set('loading', '카메라 연결 중… (허용 팝업이 뜨면 "허용")');
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 }, facingMode: 'user' }, audio: false });
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.autoplay = true; v.srcObject = this.stream;
      v.style.cssText = 'position:fixed;left:-9999px;width:2px;height:2px';
      document.body.appendChild(v);
      await v.play();
      this.video = v;
      this._set('loading', '손 인식 모델 불러오는 중…');
      const buf = await this._model();
      const vision = await import(BUNDLE);
      this.vision = vision; this.buf = buf;
      const make = async (b) => {
        try { this.lm = await this._create(vision, b, 'GPU'); this.status.delegate = 'gpu'; }
        catch { this.lm = await this._create(vision, b, 'CPU'); this.status.delegate = 'cpu'; }
      };
      try { await make(buf); }
      catch (e) {
        // 내려받다 깨진 로컬 모델 파일이면 인터넷에서 새로 받아 한 번 더
        if (this.status.model !== 'local') throw e;
        this._set('loading', '모델 파일이 올바르지 않아 인터넷에서 다시 받는 중…');
        this.buf = await this._model(true);
        await make(this.buf);
      }
      this.running = true;
      this._set('ok', '카메라 연결됨');
      requestAnimationFrame(() => this._loop());
    } catch (e) {
      const name = e && e.name;
      const msg = name === 'NotAllowedError' ? '카메라 권한이 거부됐어요 (주소창 왼쪽 자물쇠 → 카메라 허용)'
        : name === 'NotFoundError' ? '카메라를 찾지 못했어요'
        : name === 'NotReadableError' ? '다른 프로그램이 카메라를 쓰고 있어요 (카메라 앱·화상회의를 닫아 주세요)'
        : /zip archive|model/i.test((e && e.message) || '') ? '손 인식 모델 파일이 올바르지 않아요 (models 폴더의 hand_landmarker.task를 지우고 다시 실행)'
        : String((e && e.message) || e).split('\n')[0].slice(0, 90);
      this._set('error', msg);
      this.stop();
      throw e;
    }
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.video) this.video.remove();
    if (this.lm && this.lm.close) { try { this.lm.close(); } catch { /* 무시 */ } }
    this.stream = null; this.video = null; this.lm = null;
  }

  async _fallbackCpu() {
    if (this.status.delegate === 'cpu') throw new Error('CPU에서도 손 인식을 못 켰어요');
    try { this.lm.close(); } catch { /* 무시 */ }
    this.lm = await this._create(this.vision, this.buf, 'CPU');
    this.status.delegate = 'cpu';
    this.onStatus(this.status);
  }

  _loop() {
    if (!this.running) return;
    const v = this.video;
    if (v && v.readyState >= 2 && v.currentTime !== this.lastTime && v.videoWidth > 0) {
      this.lastTime = v.currentTime;
      const ts = Math.max(this.lastTs + 1, Math.round(performance.now()));
      this.lastTs = ts;
      let res = null;
      try { res = this.lm.detectForVideo(v, ts); }
      catch (e) {
        // GPU가 첫 프레임에서 실패하면 CPU로 다시 만든 뒤 계속
        this._fallbackCpu().then(() => requestAnimationFrame(() => this._loop()), (er) => { this._set('error', er.message); });
        return;
      }
      const w = v.videoWidth, h = v.videoHeight;
      const cands = candidates(res, w, h, { mirror: true }).sort((a, b) => a.nx - b.nx);
      this.fists.update(cands);
      this.times.push(performance.now()); if (this.times.length > 30) this.times.shift();
      const fps = this.times.length > 1 ? (this.times.length - 1) / ((this.times[this.times.length - 1] - this.times[0]) / 1000) : 0;
      this.status.fps = Math.round(fps * 10) / 10;
      this.last = { cands, result: res };
      this.onData(buildMessage(cands, { fps: this.status.fps, delegate: this.status.delegate }));
      if (this.preview && this.preview.style.display !== 'none') this._drawPreview();
    }
    requestAnimationFrame(() => this._loop());
  }

  // ── 손 인식 미리보기 (V 키): 카메라 화면 + 관절 + 거울 각도(deg) + 쥠 여부 ──
  togglePreview() {
    if (!this.preview) {
      const c = document.createElement('canvas');
      c.width = 480; c.height = 270;
      c.id = 'handcam';
      c.style.cssText = 'position:fixed;left:12px;bottom:12px;width:288px;height:162px;z-index:20;border:2px solid #5dff9d;border-radius:10px;background:#000;box-shadow:0 0 24px rgba(93,255,157,.35);display:none';
      document.body.appendChild(c);
      this.preview = c;
    }
    this.preview.style.display = this.preview.style.display === 'none' ? 'block' : 'none';
    return this.preview.style.display !== 'none';
  }

  _drawPreview() {
    const c = this.preview, g = c.getContext('2d'), v = this.video, W = c.width, H = c.height;
    g.save();
    g.translate(W, 0); g.scale(-1, 1);                       // 거울처럼 (내 오른손이 화면 오른쪽)
    g.drawImage(v, 0, 0, W, H);
    g.restore();
    const res = this.last.result, cands = this.last.cands;
    if (res && res.landmarks) {
      res.landmarks.forEach((lms) => {
        g.strokeStyle = '#ffe186'; g.lineWidth = 2;
        BONES.forEach(([a, b]) => { g.beginPath(); g.moveTo(W - lms[a].x * W, lms[a].y * H); g.lineTo(W - lms[b].x * W, lms[b].y * H); g.stroke(); });
        g.fillStyle = '#5dff9d';
        lms.forEach((p) => { g.beginPath(); g.arc(W - p.x * W, p.y * H, 3, 0, Math.PI * 2); g.fill(); });
      });
    }
    g.font = '700 18px sans-serif'; g.textBaseline = 'top';
    cands.forEach((h, k) => {
      const x = (1 - h.px / v.videoWidth) * W, y = (h.py / v.videoHeight) * H;
      g.fillStyle = h.fist ? '#5dff9d' : '#ffffff';
      g.fillText(`${k === 0 ? '왼' : '오른'}손 ${Math.round(h.ang)}° ${h.fist ? '✊' : '✋'} ${h.open.toFixed(2)}`, Math.max(4, Math.min(W - 170, x - 60)), Math.max(4, y + 20));
    });
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, H - 22, W, 22);
    g.fillStyle = '#9fb4d8'; g.font = '500 14px sans-serif';
    g.fillText(`${this.status.delegate.toUpperCase()} · ${this.status.fps} fps · 손 ${cands.length}개 · 모델 ${this.status.model}`, 8, H - 19);
  }
}
