// 브라우저 손 인식의 계산 부분 (DOM 없음 → node로 테스트 가능). hand.py(파이썬 서버)와 같은 규칙:
//   ang  : 손목 → 가운뎃손가락 뿌리 방향의 기울기 (도, 0~180, 반시계 +, 화면에 보이는 대로 — 손가락이 위를 향하면 90°)
//   open : 손가락 펴짐 비율 = 손가락 끝-손목 ÷ 뿌리-손목 의 평균 (주먹 약 1.0, 편한 손 약 1.6, 쫙 편 손 약 1.9)
//   fist : open 이 GRAB_CLOSE 보다 작으면 쥠, GRAB_OPEN 보다 커야 폄 (사이에서는 유지), 바뀌려면 SWITCH_FRAMES 연속
//   nx, ny: 손바닥 중심의 화면 위치 (-1..1, 거울 모드: 사용자의 오른손이 오른쪽)
export const PALM = [0, 5, 9, 13, 17];                       // 손바닥 중심 = 손목 + 손가락 뿌리 평균
export const FINGERS = [[5, 8], [9, 12], [13, 16], [17, 20]]; // 검지~새끼 (뿌리, 끝)
export const WRIST = 0, MIDDLE_MCP = 9;
export const GRAB_CLOSE = 1.20, GRAB_OPEN = 1.40, SWITCH_FRAMES = 2;
export const NX_GAIN = 1.5, NY_GAIN = 1.5;                   // 카메라 화면의 가운데 ±(1/1.5)가 게임 화면 전체에 대응 (손이 화면 끝까지 안 가도 됨)
export const DEPTH_REF = 0.7;                                // 웹캠은 깊이가 없어서 고정값 (m)
export const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function fingerLineAngle(x0, y0, x1, y1, mirror = true) {
  const vy = y1 - y0;
  let vx = x1 - x0;
  if (mirror) vx = -vx;                                     // 화면이 좌우 반전돼 보이므로 x를 뒤집음
  return (((Math.atan2(-vy, vx) * 180) / Math.PI) % 180 + 180) % 180;
}

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** MediaPipe HandLandmarker 결과 → 후보 손 목록. w,h = 영상 크기(px, 각도 계산에서 가로세로 비율 유지) */
export function candidates(result, w, h, { mirror = true } = {}) {
  const out = [];
  const lmsAll = (result && result.landmarks) || [], worldAll = (result && (result.worldLandmarks || result.worldLandmarks)) || [];
  for (let i = 0; i < lmsAll.length; i++) {
    const lms = lmsAll[i];
    if (!lms || lms.length < 21) continue;
    const px = (PALM.reduce((s, j) => s + lms[j].x, 0) / PALM.length) * w;
    const py = (PALM.reduce((s, j) => s + lms[j].y, 0) / PALM.length) * h;
    const world = worldAll[i];
    let open = 1.6;                                          // 월드 좌표가 없으면 편한 손으로 간주
    if (world && world.length >= 21) {
      const ratios = FINGERS.map(([mcp, tip]) => dist3(world[tip], world[0]) / Math.max(1e-6, dist3(world[mcp], world[0])));
      open = ratios.reduce((s, r) => s + r, 0) / ratios.length;
    }
    const ang = fingerLineAngle(lms[WRIST].x * w, lms[WRIST].y * h, lms[MIDDLE_MCP].x * w, lms[MIDDLE_MCP].y * h, mirror);
    const nxRaw = (px / w - 0.5) * 2 * NX_GAIN, nyRaw = -(py / h - 0.5) * 2 * NY_GAIN;
    out.push({ i, px, py, nx: clamp(mirror ? -nxRaw : nxRaw, -1.5, 1.5), ny: clamp(nyRaw, -1.5, 1.5), open, ang, d: DEPTH_REF });
  }
  return out;
}

/** 두 손 각각의 쥠 상태 (화면 왼쪽 손 = 0). hands.py 의 slot_fist 와 같은 로직 */
export class FistTracker {
  constructor({ close = GRAB_CLOSE, open = GRAB_OPEN, frames = SWITCH_FRAMES } = {}) {
    this.close = close; this.openT = open; this.frames = frames;
    this.fist = [false, false]; this.flip = [0, 0]; this.n = 0;
  }
  /** hands: nx 오름차순으로 정렬된 후보 목록. 각 손에 fist 를 채워 돌려줌 */
  update(hands) {
    if (hands.length !== this.n) {                           // 손 수가 바뀌면 상태를 새로 시작
      this.n = hands.length;
      this.fist = [...hands.map((h) => h.open < this.close), false, false].slice(0, 2);
      this.flip = [0, 0];
    }
    hands.forEach((h, k) => {
      if (k > 1) { h.fist = false; return; }
      const want = !this.fist[k] ? h.open < this.close : !(h.open > this.openT);
      this.flip[k] = want !== this.fist[k] ? this.flip[k] + 1 : 0;
      if (this.flip[k] >= this.frames) { this.fist[k] = want; this.flip[k] = 0; }
      h.fist = this.fist[k];
    });
    return hands;
  }
  reset() { this.fist = [false, false]; this.flip = [0, 0]; this.n = 0; }
}

const r = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

/** 서버 /hand 메시지와 같은 모양: LaserInput.onData 가 그대로 받음 */
export function buildMessage(hands, extra = {}) {
  const list = [...hands].sort((a, b) => a.nx - b.nx).slice(0, 2);
  const first = list[0];
  return {
    available: true, visible: list.length > 0, camera: 'browser', mirror: true, ...extra,
    ...(first ? { nx: r(first.nx, 4), ny: r(first.ny, 4), d: DEPTH_REF, grab: !!first.fist, open: r(first.open, 3) } : {}),
    hands: list.map((h) => ({ nx: r(h.nx, 4), ny: r(h.ny, 4), d: DEPTH_REF, ang: r(h.ang, 1), open: r(h.open, 3), fist: !!h.fist })),
  };
}
