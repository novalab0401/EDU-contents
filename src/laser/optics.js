// 레이저 챌린지 광학 엔진 (DOM 없음 → 브라우저와 node 테스트 모두에서 사용)
//
// 좌표: 캔버스 좌표 (x 오른쪽, y 아래). 각도는 "화면에서 보이는 각도" (도, 반시계가 +, 오른쪽=0°, 위=90°).
// 거울 각도 = 거울 선이 기울어진 각도 (0~180°, 180° 주기). 반사: r = d − 2(d·n)n  (n: 거울의 법선)
//
// scene = {
//   W, H,
//   emitter: {x, y, angle},
//   mirrors:   [{id, kind:'hand'|'fixed', x, y, len, angle}],
//   obstacles: [{x, y, w, h}],                     // 불투명 사각형 (레이저 흡수)
//   targets:   [{id, order, color, x, y, r}],      // 레이저가 지나가면 활성화 (order 순서대로만 인정)
// }
export const EPS = 1e-6;
export const NUDGE = 0.01;          // 반사 직후 같은 거울에 다시 맞지 않게 살짝 밀어 줌 (px)
export const MAX_REFLECT = 10;

export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;
export const dirFromDeg = (a) => ({ x: Math.cos(rad(a)), y: -Math.sin(rad(a)) });
/** 각도 차이를 (-90, 90]로 (거울 선은 180° 주기) */
export function lineDiff(a, b) {
  let d = (((a - b) % 180) + 180) % 180;
  if (d > 90) d -= 180;
  return d;
}
export const norm180 = (a) => ((a % 180) + 180) % 180;

export function mirrorEnds(m) {
  const u = dirFromDeg(m.angle), h = m.len / 2;
  return [{ x: m.x - u.x * h, y: m.y - u.y * h }, { x: m.x + u.x * h, y: m.y + u.y * h }];
}

/** 방향 d를 거울 선(단위벡터 u)에 반사:  r = d − 2(d·n)n = 2(d·u)u − d */
export function reflect(d, u) {
  const k = 2 * (d.x * u.x + d.y * u.y);
  return { x: k * u.x - d.x, y: k * u.y - d.y };
}

export function obstacleSegs(o) {
  const a = { x: o.x, y: o.y }, b = { x: o.x + o.w, y: o.y }, c = { x: o.x + o.w, y: o.y + o.h }, d = { x: o.x, y: o.y + o.h };
  return [[a, b], [b, c], [c, d], [d, a]];
}

/** 광선 p + t·d 와 선분 a-b 의 교점 t (없으면 null). 가장 가까운 교점을 고르기 위해 t만 돌려줌 */
function raySeg(p, d, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y;
  const den = d.x * ey - d.y * ex;
  if (Math.abs(den) < 1e-12) return null;            // 평행
  const apx = a.x - p.x, apy = a.y - p.y;
  const t = (apx * ey - apy * ex) / den;
  const s = (apx * d.y - apy * d.x) / den;
  return t > EPS && s >= -1e-9 && s <= 1 + 1e-9 ? t : null;
}

function buildWalls(scene) {
  const walls = [];
  for (const m of scene.mirrors) { const [a, b] = mirrorEnds(m); walls.push({ a, b, kind: 'mirror', ref: m }); }
  scene.obstacles.forEach((o, i) => { for (const [a, b] of obstacleSegs(o)) walls.push({ a, b, kind: 'obstacle', ref: o, index: i }); });
  const { W, H } = scene;
  const B = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  for (let i = 0; i < 4; i++) walls.push({ a: B[i], b: B[(i + 1) % 4], kind: 'boundary' });
  return walls;
}

/**
 * 레이저 한 발의 경로.
 * 반환: { segments:[{x1,y1,x2,y2, mirrorId|null}], hits:[{id, order, x, y, seg}], endReason, blockedBy }
 *  - 가장 가까운 교점(거울/장애물/경계)을 찾고, 거울이면 반사해서 계속, 아니면 거기서 끝
 *  - 타깃은 센서: 레이저가 지나가면 (경로 순서대로) hits에 기록, 레이저는 계속 나아감
 */
export function trace(scene, opts = {}) {
  const maxReflect = opts.maxReflect ?? MAX_REFLECT;
  const walls = buildWalls(scene);
  const segments = [], hits = [];
  let p = { x: scene.emitter.x, y: scene.emitter.y };
  let d = dirFromDeg(scene.emitter.angle);
  let endReason = 'max_reflect', blockedBy = null;
  for (let i = 0; i <= maxReflect; i++) {
    let best = null;
    for (const w of walls) {
      const t = raySeg(p, d, w.a, w.b);
      if (t !== null && (best === null || t < best.t)) best = { t, w };
    }
    if (!best) { endReason = 'escaped'; break; }          // 경계가 있으니 사실상 일어나지 않음
    const q = { x: p.x + d.x * best.t, y: p.y + d.y * best.t };
    // 이 선분을 지나는 타깃 (경로 순서대로)
    const segHits = [];
    for (const tg of scene.targets) {
      const tc = Math.max(0, Math.min(best.t, (tg.x - p.x) * d.x + (tg.y - p.y) * d.y));
      const cx = p.x + d.x * tc, cy = p.y + d.y * tc;
      if (Math.hypot(tg.x - cx, tg.y - cy) <= tg.r) segHits.push({ id: tg.id, order: tg.order, x: cx, y: cy, seg: segments.length, tc });
    }
    segHits.sort((a, b) => a.tc - b.tc);
    for (const h of segHits) hits.push(h);
    segments.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, mirrorId: best.w.kind === 'mirror' ? best.w.ref.id : null });
    if (best.w.kind === 'mirror') {
      const m = best.w.ref, u = dirFromDeg(m.angle);
      d = reflect(d, u);
      p = { x: q.x + d.x * NUDGE, y: q.y + d.y * NUDGE };
      if (i === maxReflect) endReason = 'max_reflect';
      continue;
    }
    if (best.w.kind === 'obstacle') { endReason = 'blocked'; blockedBy = best.w.index; }
    else endReason = 'boundary';
    break;
  }
  return { segments, hits, endReason, blockedBy };
}

/** 한 발의 결과를 점수 상태에 반영: 타깃은 order 0,1,2… 순서대로만 인정 */
export function evaluate(trc, progress) {
  let prog = progress;
  const events = [];
  for (const h of trc.hits) {
    if (h.order < prog) continue;                                 // 이미 활성화됨
    if (h.order === prog) { prog++; events.push({ type: 'TARGET_HIT', id: h.id, order: h.order, x: h.x, y: h.y, seg: h.seg }); }
    else events.push({ type: 'TARGET_WRONG_ORDER', id: h.id, order: h.order, expected: prog, x: h.x, y: h.y, seg: h.seg });
  }
  return { progress: prog, events };
}

export function totalLength(trc) {
  return trc.segments.reduce((s, g) => s + Math.hypot(g.x2 - g.x1, g.y2 - g.y1), 0);
}
