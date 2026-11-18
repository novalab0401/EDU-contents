// 붕괴 분석 모듈: 매 틱 접촉력 스냅숏으로 3대 공학 원리를 계산하고, 붕괴 순간 가장 먼저 임계치를 넘은 원인을 판별
//  ① 기저면 이탈   : 접촉면 위에 얹힌 하중의 무게중심(CoM)에서 내린 수직선이 아래 지지면(접촉점 볼록 껍질) 밖으로
//  ② 돌림힘 과부하 : 실제 접촉력(충격·밀기 포함)의 합력이 만드는 전도 모멘트 Στ = r × F 가 지지면의 저항 모멘트를 넘음
//  ③ 마찰력 한계   : 접촉면 방향 전단력이 최대 정지마찰력 f_s = μ·N 을 넘음
// 비율(ratio) = 작용 / 한계. 1(100%)을 넘으면 임계치 초과
import * as THREE from 'three';
import { Vec3 } from 'cannon-es';
import { G, UNIT } from './physics.js';

export const CAUSES = {
  bos:      { name: '기저면 이탈',      en: 'Loss of Base of Support', color: '#ff6b6b' },
  torque:   { name: '돌림힘 과부하',    en: 'Torque / Moment Overload', color: '#ffb347' },
  friction: { name: '마찰력 한계 초과', en: 'Friction Limit Exceeded', color: '#5fd4ff' },
};
const KEYS = ['bos', 'torque', 'friction'];

const SETTLE_TIME = 0.5;      // 이만큼 멈춰 있으면 탑의 일부로 인정 (s)
const COUNT_TIME = 1.0;       // 최고 층수로 인정하려면 이만큼 버텨야 함 (s)
const STILL_V = 0.12, STILL_W = 0.5;              // 멈춤 판정 속도 (m/s, rad/s)
const MOVE_DIST = 0.3, MOVE_ANGLE = 35 * Math.PI / 180;   // 자리에서 이만큼 벗어나면 '무너짐'
const QUASI_V = 0.3, QUASI_W = 1.0;               // 이보다 느린 블록은 정적 하중으로 취급 (m/s, rad/s)
const SUSTAIN = 3;            // 임계치를 이 횟수(틱) 연속 넘어야 '넘음'으로 기록 (순간 튐 무시)
const COOLDOWN = 2.5;         // 리포트 뒤 이 시간 동안은 무너지는 잔해를 새 붕괴로 세지 않음 (s)
const LOOKBACK = 1.5;         // 붕괴 시점에서 거슬러 올라가 원인을 찾는 시간 (s)
const BOS_TIE = 0.15;         // 돌림힘 직후 이 시간 안에 기저면도 넘으면 정적인 기울어짐 → 기저면 이탈로 판정 (s)
const DEGEN_AREA = 2e-3, DEGEN_TOL = 0.03;        // 접촉이 점·선(모서리로 섬)일 때 허용 오차 (m², m)
const SLEEPING = 2;

// ── 2D 기하 ([x, z]) ──────────────────────────────────────
function convexHull(points) {
  const p = points.map(q => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts) => {
    const h = [];
    for (const q of pts) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 1e-10) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return half(p).concat(half([...p].reverse()));
}

function polyArea(h) {
  let a = 0;
  for (let i = 0; i < h.length; i++) { const j = (i + 1) % h.length; a += h[i][0] * h[j][1] - h[j][0] * h[i][1]; }
  return a / 2;
}

function polyCentroid(h) {
  let a = 0, x = 0, z = 0;
  for (let i = 0; i < h.length; i++) {
    const j = (i + 1) % h.length, k = h[i][0] * h[j][1] - h[j][0] * h[i][1];
    a += k; x += (h[i][0] + h[j][0]) * k; z += (h[i][1] + h[j][1]) * k;
  }
  return [x / (3 * a), z / (3 * a)];
}

function distToHull(h, P) {
  if (h.length === 1) return Math.hypot(P[0] - h[0][0], P[1] - h[0][1]);
  let d = Infinity;
  for (let i = 0; i < h.length; i++) {
    const A = h[i], B = h[(i + 1) % h.length], ex = B[0] - A[0], ez = B[1] - A[1];
    const L2 = ex * ex + ez * ez || 1e-12;
    const k = Math.max(0, Math.min(1, ((P[0] - A[0]) * ex + (P[1] - A[1]) * ez) / L2));
    d = Math.min(d, Math.hypot(P[0] - A[0] - k * ex, P[1] - A[1] - k * ez));
  }
  return d;
}

// 점 P가 지지면 중심 c에서 경계 쪽으로 얼마나 나갔는지: e = |P - c|, s = 같은 방향 경계까지 거리, ratio = e / s
export function hullRatio(hull, P) {
  if (hull.length < 3 || Math.abs(polyArea(hull)) < DEGEN_AREA) {
    const c = [0, 1].map(i => hull.reduce((s, q) => s + q[i], 0) / hull.length);
    const e = distToHull(hull, P);
    return { ratio: e / DEGEN_TOL, e, s: DEGEN_TOL, c, edge: c, degenerate: true };
  }
  const c = polyCentroid(hull);
  const dx = P[0] - c[0], dz = P[1] - c[1], e = Math.hypot(dx, dz);
  if (e < 1e-6) return { ratio: 0, e: 0, s: 1, c, edge: c };
  const u = [dx / e, dz / e];
  let s = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const A = hull[i], B = hull[(i + 1) % hull.length];
    const ex = B[0] - A[0], ez = B[1] - A[1], den = u[0] * ez - u[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = A[0] - c[0], wz = A[1] - c[1];
    const t = (wx * ez - wz * ex) / den, k = (wx * u[1] - wz * u[0]) / den;
    if (t > 0 && k >= -1e-9 && k <= 1 + 1e-9) s = Math.min(s, t);
  }
  if (!isFinite(s)) s = DEGEN_TOL;
  return { ratio: e / s, e, s, c, edge: [c[0] + u[0] * s, c[1] + u[1] * s] };
}

// 볼록 다각형 subject를 볼록 다각형 clip(반시계)으로 자름 (Sutherland–Hodgman) = 두 면이 겹치는 영역
function clipPoly(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const A = clip[i], B = clip[(i + 1) % clip.length];
    const side = (p) => (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const P = inp[j], Q = inp[(j + 1) % inp.length], sp = side(P), sq = side(Q);
      if (sp >= -1e-9) out.push(P);
      if ((sp >= -1e-9) !== (sq >= -1e-9)) {
        const k = sp / (sp - sq);
        out.push([P[0] + k * (Q[0] - P[0]), P[1] + k * (Q[1] - P[1])]);
      }
    }
  }
  return out;
}

// 몸체의 면 목록(몸체 기준 법선 + 꼭짓점). 한 번만 계산해 몸체에 저장
function localFaces(body) {
  if (body._faces) return body._faces;
  const out = [];
  body.shapes.forEach((sh, i) => {
    const poly = sh.convexPolyhedronRepresentation || sh, off = body.shapeOffsets[i], q = body.shapeOrientations[i];
    if (!poly.faces) return;
    poly.faces.forEach((f, k) => {
      const n = q.vmult(poly.faceNormals[k]);
      const verts = f.map(vi => { const w = q.vmult(poly.vertices[vi]); return new Vec3(w.x + off.x, w.y + off.y, w.z + off.z); });
      out.push({ n, verts });
    });
  });
  return (body._faces = out);
}

// dir 방향을 가장 정면으로 향한 면의 수평 투영 (예: 아래 방향 → 바닥면). 기울어져도 면 전체를 씀
function facePoly(body, dir) {
  const q = body.quaternion, p = body.position, d = new Vec3(...dir), w = new Vec3();
  let best = null, bestDot = -Infinity;
  for (const f of localFaces(body)) {
    const dot = q.vmult(f.n, w).dot(d);
    if (dot > bestDot) { bestDot = dot; best = f; }
  }
  if (!best) return [];
  return convexHull(best.verts.map(v => { q.vmult(v, w); return [w.x + p.x, w.z + p.z]; }));
}

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// 블록(body)이 아래 물체(lower) 위에 놓인 지지면 = 맞닿은 두 면(위 블록 바닥면 ∩ 아래 물체 윗면)의 겹친 영역.
// cannon은 평평하게 놓인 블록도 접촉점을 모서리 2~3개만 줄 때가 있고, 넘어지기 시작하면 모서리만 닿으므로
// 접촉점 대신 형상의 면으로 계산 (정적 넘어짐 기준 = 무게중심이 겹친 면 밖으로). 겹침이 없으면 접촉점 사용
function supportPolygon(body, lower, rec, s) {
  const P0y = rec.pts.reduce((a, pt) => a + pt.p[1], 0) / rec.pts.length;
  const n = rec.n.map(v => s * v);
  const A = facePoly(body, n.map(v => -v)), B = facePoly(lower, n);
  if (A.length >= 3 && B.length >= 3) {
    const C = clipPoly(A, B);
    if (C.length >= 3 && Math.abs(polyArea(C)) > DEGEN_AREA) return C.map(([x, z]) => [x, P0y, z]);
  }
  return rec.pts.map(pt => pt.p);
}

export const toFloor = (y) => Math.max(0, Math.floor(y / UNIT * 10 + 0.3) / 10);

export class Analyzer {
  constructor(physics) {
    this.ph = physics;
    this.reset();
  }

  reset() {
    this.t = 0;
    this.members = new Map();     // 블록 id → 자리 잡은 위치 {pos, quat, base}
    this.history = [];            // 최근 2.5초 틱 기록 (비율 + 자세 스냅숏)
    this.crossings = [];          // 임계치 넘은 기록
    this.run = { bos: 0, torque: 0, friction: 0 };
    this.runStart = {};
    this.lastSupportGrab = -99;
    this.cooldownUntil = 0;
    for (const b of this.ph.blocks) b.still = 0;
  }

  // 리포트를 닫고 게임을 이어갈 때: 기록을 비우고 잠시 붕괴 감지를 쉼 (남은 탑은 그대로)
  resume() {
    this.history = [];
    this.crossings = [];
    this.run = { bos: 0, torque: 0, friction: 0 };
    this.cooldownUntil = this.t + COOLDOWN;
  }

  // 탑에 있던 블록을 손으로 집으면 탑에서 빼고, 위에 다른 블록을 받치고 있었다면 시각 기록 (지지 블록 제거 판정용)
  noteGrab(blk) {
    const mem = this.members.get(blk.id);
    if (mem?.supports) this.lastSupportGrab = this.t;
    this.members.delete(blk.id);
  }

  update(dt) {
    this.t += dt;
    const ph = this.ph, plat = ph.platform;
    const blocks = new Map();     // body.id → Block (물리 월드 안, 손에 없는 것)
    for (const b of ph.blocks) if (b.inWorld && !b.held) blocks.set(b.body.id, b);
    const heldBody = ph.held?.body;

    // 1) 접촉 쌍 분류: sup = 내가 위에 놓인 면, other = 나머지 접촉(위에서 누름·옆·손), adj = 연결
    const sup = new Map(), other = new Map(), adj = new Map();
    const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
    for (const rec of ph.pairs.values()) {
      const A = rec.a, B = rec.b;
      if (!blocks.has(A.id) && !blocks.has(B.id)) continue;
      const upper = rec.n[1] > 0.5 ? B : rec.n[1] < -0.5 ? A : null;
      if (A !== heldBody && B !== heldBody) { push(adj, A.id, B.id); push(adj, B.id, A.id); }
      for (const X of [A, B]) if (blocks.has(X.id)) push(X === upper ? sup : other, X.id, rec);
    }

    // 2) 플랫폼과 이어진 블록 = 탑
    const tower = new Set(), stack = [plat.id];
    while (stack.length) {
      for (const nb of adj.get(stack.pop()) || []) {
        if (!tower.has(nb) && blocks.has(nb)) { tower.add(nb); stack.push(nb); }
      }
    }

    // 3) 하중 묶음: 위에서부터 내려오며 각 블록이 떠받치는 하중을 모음
    //    정적 참여 블록(자리 잡았거나 거의 멈춘 블록)끼리의 하중 = 질량·무게중심 (솔버 접촉력의 인공적 치우침 배제)
    //    빠르게 움직이는 블록·손에 든 블록이 주는 힘 = 실제 접촉력 (충격·밀기 같은 동적 하중)
    //    아래 받침이 하나면 그대로, 여럿(다리 구조)이면 수직항력 비율로 나눠 각 접촉 지점에 전달
    const partic = new Set();
    for (const id of tower) {
      const blk = blocks.get(id), b = blk.body;
      if (this.members.has(blk.id) || (b.velocity.length() < QUASI_V && b.angularVelocity.length() < QUASI_W)) partic.add(id);
    }
    const pack = new Map();      // id → { m, x, y, z (질량 가중 합), n (블록 수), F (힘 합), M (원점 기준 모멘트 합) }
    for (const id of partic) {
      const body = blocks.get(id).body, { mass: m, position: p } = body;
      const P = { m, x: m * p.x, y: m * p.y, z: m * p.z, n: 1, F: [0, -m * G, 0], M: [0, 0, 0] };
      P.M = cross3([p.x, p.y, p.z], P.F);
      for (const r of other.get(id) || []) {
        const s = r.b === body ? 1 : -1, Y = s > 0 ? r.a : r.b;
        if (partic.has(Y.id)) continue;
        const add = (f, at) => {
          const mm = cross3(at, f);
          for (let i = 0; i < 3; i++) { P.F[i] += f[i]; P.M[i] += mm[i]; }
        };
        for (const pt of r.pts) add(pt.n.map(v => s * pt.N * v), pt.p);
        add(r.F.map(v => s * v), r.cop);
      }
      pack.set(id, P);
    }
    const order = [...partic].sort((i, j) => blocks.get(j).body.position.y - blocks.get(i).body.position.y);
    for (const id of order) {
      const recs = sup.get(id);
      if (!recs) continue;
      const P = pack.get(id), body = blocks.get(id).body;
      const lowerOf = (r) => (r.a === body ? r.b : r.a);
      if (recs.length === 1) {
        const L = pack.get(lowerOf(recs[0]).id);
        if (!L) continue;
        L.m += P.m; L.x += P.x; L.y += P.y; L.z += P.z; L.n += P.n;
        for (let i = 0; i < 3; i++) { L.F[i] += P.F[i]; L.M[i] += P.M[i]; }
        continue;
      }
      const Nsum = recs.reduce((a, r) => a + r.N, 0);
      for (const r of recs) {
        const L = pack.get(lowerOf(r).id);
        if (!L) continue;
        const w = Nsum > 1e-6 ? r.N / Nsum : 1 / recs.length, m = w * P.m, f = P.F.map(v => w * v), mm = cross3(r.cop, f);
        L.m += m; L.x += m * r.cop[0]; L.y += m * r.cop[1]; L.z += m * r.cop[2]; L.n += w * P.n;
        for (let i = 0; i < 3; i++) { L.F[i] += f[i]; L.M[i] += mm[i]; }
      }
    }

    // 4) 접촉면(블록이 아래 물체 위에 놓인 면)마다 세 비율 계산, 가장 큰 값을 보관
    let bos = null, torque = null, friction = null;
    // 탑에 자리 잡은 블록만 평가 (막 내려놓아 튀는 중인 블록은 제외, 그 힘은 아래 블록의 하중으로 반영)
    for (const id of tower) {
      const recs = sup.get(id);
      const blk = blocks.get(id);
      if (!recs || !this.members.has(blk.id) || !pack.has(id)) continue;
      const body = blk.body, m = body.mass;
      const pts = [], O = [0, 0, 0], nUp = [0, 0, 0];
      let Nsum = 0, muN = 0, muSum = 0, onHeld = false;
      for (const r of recs) {
        const s = r.b === body ? 1 : -1, w = r.N + 1e-3;
        const lower = s > 0 ? r.a : r.b;
        if (lower === heldBody) onHeld = true;
        for (const p of supportPolygon(body, lower, r, s)) {
          pts.push([p[0], p[2]]);
          for (let i = 0; i < 3; i++) O[i] += p[i];
        }
        for (let i = 0; i < 3; i++) nUp[i] += s * w * r.n[i];
        Nsum += r.N; muN += r.mu * r.N; muSum += r.mu;
      }
      for (let i = 0; i < 3; i++) O[i] /= pts.length;
      const nl = Math.hypot(...nUp) || 1;
      for (let i = 0; i < 3; i++) nUp[i] /= nl;
      const mu = Nsum > 1e-6 ? muN / Nsum : muSum / recs.length;
      const hull = convexHull(pts);
      const base = { id, type: blk.type, y0: O[1], hull, onHeld };

      // ① 기저면: 이 면 위 하중의 무게중심
      const P = pack.get(id);
      const com = [P.x / P.m, P.y / P.m, P.z / P.m];
      const hb = hullRatio(hull, [com[0], com[2]]);
      if (!bos || hb.ratio > bos.ratio) bos = { ...base, ...hb, com, W: P.m * G, count: Math.round(P.n) };

      // 이 면이 받는 하중 합력 F와 O 기준 모멘트 (정적 무게 + 동적 접촉력)
      const F = P.F, MO = cross3(O, F), M = [P.M[0] - MO[0], P.M[1] - MO[1], P.M[2] - MO[2]];

      // ② 돌림힘: 합력이 접촉면을 지나는 점 = 모멘트가 0이 되는 점
      if (F[1] < -0.2 * m * G) {
        const Pt = [O[0] + M[2] / F[1], O[2] - M[0] / F[1]];
        const ht = hullRatio(hull, Pt);
        if (!torque || ht.ratio > torque.ratio) {
          const Fv = -F[1];
          torque = { ...base, ...ht, P: Pt, F: [...F], Fv, Mo: Fv * ht.e, Mr: Fv * ht.s };
        }
      }

      // ③ 마찰: 접촉면 방향 성분(전단력) vs μ × 수직 성분
      const Fn = -dot3(F, nUp);
      if (Fn > 0.2 * m * G && mu > 0) {
        const Ftv = F.map((v, i) => v + Fn * nUp[i]);
        const Ft = Math.hypot(...Ftv);
        const ratio = Ft / (mu * Fn);
        if (!friction || ratio > friction.ratio) friction = { ...base, ratio, O: [...O], nUp, Ftv, Ft, Fn, mu };
      }
    }

    // 5) 탑 구성원(자리 잡은 블록), 높이, 무너짐 감지
    let top = 0, stableTop = 0, displaced = 0;
    const cooling = this.t < this.cooldownUntil;
    const alive = new Set();
    for (const blk of ph.blocks) {
      if (!blk.inWorld || blk.held) continue;
      alive.add(blk.id);
      const b = blk.body;
      const still = b.sleepState === SLEEPING || (b.velocity.length() < STILL_V && b.angularVelocity.length() < STILL_W);
      blk.still = still ? blk.still + dt : 0;
      let mem = this.members.get(blk.id);
      if (tower.has(b.id) && blk.still >= SETTLE_TIME) {
        if (!mem) this.members.set(blk.id, mem = {});
        mem.pos = [b.position.x, b.position.y, b.position.z];
        mem.quat = [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w];
        // 다른 블록 위에 있거나 다른 블록을 받치고 있으면 '쌓인' 블록 (플랫폼에 홀로 놓인 블록은 제외)
        mem.supports = (other.get(b.id) || []).some(r => (r.a === b && r.n[1] > 0.5) || (r.b === b && r.n[1] < -0.5));
        mem.stacked = mem.supports || (sup.get(b.id) || []).some(r => r.a !== plat && r.b !== plat);
        const yTop = ph.aabb(blk).upperBound.y;
        top = Math.max(top, yTop);
        if (blk.still >= COUNT_TIME) stableTop = Math.max(stableTop, yTop);
        continue;
      }
      if (!mem) continue;
      const p = b.position, q = b.quaternion;
      const dist = Math.hypot(p.x - mem.pos[0], p.y - mem.pos[1], p.z - mem.pos[2]);
      const qd = Math.abs(q.x * mem.quat[0] + q.y * mem.quat[1] + q.z * mem.quat[2] + q.w * mem.quat[3]);
      const angle = 2 * Math.acos(Math.min(1, qd));
      if (dist > MOVE_DIST || angle > MOVE_ANGLE || p.y < -0.3) {
        if (cooling) this.members.delete(blk.id);   // 직전 붕괴의 잔해
        else if (mem.stacked) displaced++;
      } else if (tower.has(b.id)) {
        top = Math.max(top, ph.aabb(blk).upperBound.y);
      }
    }
    for (const id of this.members.keys()) if (!alive.has(id)) this.members.delete(id);
    const nMem = this.members.size;
    const collapsed = !cooling && nMem >= 2 && displaced >= 1;

    // 6) 기록: 임계치(100%)를 SUSTAIN 틱 연속 넘으면 '넘음' 시점을 저장
    const entry = { t: this.t, bos, torque, friction, poses: this._poses() };
    this.history.push(entry);
    while (this.history[0].t < this.t - 2.5) this.history.shift();
    for (const k of KEYS) {
      if ((entry[k]?.ratio ?? 0) >= 1) {
        if (++this.run[k] === 1) this.runStart[k] = entry;
        if (this.run[k] === SUSTAIN) this.crossings.push({ key: k, entry: this.runStart[k] });
      } else this.run[k] = 0;
    }
    this.crossings = this.crossings.filter(c => c.entry.t >= this.t - 3);

    return {
      top, floor: toFloor(top), stableFloor: toFloor(stableTop), members: nMem, displaced,
      ratios: { bos: bos?.ratio ?? 0, torque: torque?.ratio ?? 0, friction: friction?.ratio ?? 0 },
      report: collapsed ? this._diagnose() : null,
    };
  }

  _poses() {
    const m = new Map();
    for (const b of this.ph.blocks) {
      if (!b.inWorld) continue;
      const p = b.body.position, q = b.body.quaternion;
      m.set(b.id, [p.x, p.y, p.z, q.x, q.y, q.z, q.w]);
    }
    return m;
  }

  // 붕괴 원인 판별: 최근 LOOKBACK초 안에서 가장 먼저 임계치를 넘은 원리
  _diagnose() {
    const t0 = this.t - LOOKBACK;
    const recent = this.crossings.filter(c => c.entry.t >= t0).sort((a, b) => a.entry.t - b.entry.t);
    let key, entry, mode;
    if (this.t - this.lastSupportGrab < 2.0) {
      // 아래에서 받치던 블록을 손으로 빼냄 → 위 블록들이 지지면을 잃음
      mode = 'removed';
      key = 'bos';
      entry = this.history.reduce((a, e) => (Math.abs(e.t - this.lastSupportGrab) < Math.abs(a.t - this.lastSupportGrab) ? e : a));
    } else if (recent.length) {
      // 같은 순간(한 틱 이내)에 여럿이 넘었으면 비율이 더 큰 쪽 = 더 작은 힘에서 이미 한계였던 원리
      const first = recent.filter(c => c.entry.t - recent[0].entry.t < 0.02);
      ({ key, entry } = first.reduce((a, c) => (c.entry[c.key].ratio > a.entry[a.key].ratio ? c : a)));
      mode = 'crossed';
      const b = recent.find(c => c.key === 'bos' && c.entry.t - entry.t <= BOS_TIE);
      if (key === 'torque' && b) ({ key, entry } = b);
    } else {
      // 100%를 꾸준히 넘은 원리 없이 무너짐 (예: 순간 충격) → 가장 크게 치솟았던 원리
      mode = 'peak';
      let best = null;
      for (const e of this.history) {
        if (e.t < t0) continue;
        for (const k of KEYS) if (e[k] && (!best || e[k].ratio > best.r)) best = { k, e, r: e[k].ratio };
      }
      if (best) ({ k: key, e: entry } = best);
      else { key = 'bos'; entry = this.history[this.history.length - 1]; mode = 'unknown'; }
    }
    return {
      key, mode, entry, detail: entry[key], before: this.t - entry.t,
      ratios: { bos: entry.bos?.ratio ?? 0, torque: entry.torque?.ratio ?? 0, friction: entry.friction?.ratio ?? 0 },
    };
  }
}

// ── 리포트 문구 ───────────────────────────────────────────
const f1 = (v) => v.toFixed(1), f2 = (v) => v.toFixed(2);
const pct = (r) => `${Math.round(r * 100)}%`;

export function describeReport(rep, typeName) {
  const c = CAUSES[rep.key], d = rep.detail;
  const where = d ? `${toFloor(d.y0).toFixed(1)}층 높이(${f2(d.y0)} m)` : '';
  const out = { title: c.name, en: c.en, color: c.color, lines: [], summary: '', tip: '', note: '' };
  if (rep.mode === 'removed') {
    out.summary = '아래에서 받치던 블록을 빼내는 순간 위층 블록들의 지지면이 사라졌습니다.';
    out.tip = '탑 중간의 블록은 빼지 말고, 새 블록은 맨 위에 올리세요.';
    return out;
  }
  if (!d) { out.summary = '탑이 무너졌습니다.'; return out; }
  if (rep.key === 'bos') {
    out.summary = `${where} 접촉면 위에 얹힌 블록 ${d.count}개의 무게중심(CoM)에서 내린 수직선이 아래 지지면 밖으로 벗어났습니다.`;
    out.lines = [
      ['얹힌 무게 W', `${f1(d.W)} N`],
      ['무게중심 편심 e', `${f2(d.e)} m`],
      ['지지면 경계까지', `${f2(d.s)} m`],
      ['e ÷ 경계 거리', pct(d.ratio)],
    ];
    out.tip = '무겁고 넓은 블록을 아래에 두면 무게중심은 낮아지고 지지면은 넓어집니다.';
  } else if (rep.key === 'torque') {
    out.summary = `${where} 접촉면에서 한쪽으로 쏠린 하중이 만든 회전 모멘트가 지지면이 버틸 수 있는 크기를 넘었습니다.`;
    out.lines = [
      ['하중 합력 F', `${f1(d.Fv)} N`],
      ['팔 길이 r', `${f2(d.e)} m`],
      ['전도 모멘트 Στ = r × F', `${f2(d.Mo)} N·m`],
      ['저항 모멘트 (한계)', `${f2(d.Mr)} N·m`],
      ['전도 ÷ 저항', pct(d.ratio)],
    ];
    out.tip = '블록을 아래 블록 중심에 맞춰 올리고, 한쪽으로 튀어나왔다면 반대편에 균형추를 두세요.';
  } else {
    out.summary = `${where} ${typeName ? typeName + ' 블록 아래 ' : ''}접촉면에서 미는 힘(전단력)이 최대 정지마찰력을 넘어 미끄러졌습니다.`;
    out.lines = [
      ['수직항력 N', `${f1(d.Fn)} N`],
      ['마찰계수 μ', f2(d.mu)],
      ['최대 정지마찰력 f_s = μN', `${f2(d.mu * d.Fn)} N`],
      ['전단력 F', `${f2(d.Ft)} N`],
      ['F ÷ μN', pct(d.ratio)],
    ];
    out.tip = '얼음처럼 μ가 작은 블록, 경사면 위는 미끄럽습니다. 던지지 말고 살며시 내려놓으세요.';
  }
  if (rep.mode === 'crossed') out.note = `붕괴 ${rep.before.toFixed(2)}초 전에 처음 임계치(100%)를 넘었습니다.`;
  else if (d.ratio >= 1) out.note = `붕괴 ${rep.before.toFixed(2)}초 전 순간적으로 ${pct(d.ratio)}까지 치솟았습니다 (충격 하중).`;
  else out.note = '세 원리 모두 100%를 넘기 전에 무너져, 가장 임계치에 가까웠던 원인을 표시합니다.';
  return out;
}

// ── 붕괴 리포트 3D 벡터 시각화 ────────────────────────────────
const UP = new THREE.Vector3(0, 1, 0);
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

function overlayMat(color, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
}

function arrow(from, dir, len, color) {
  const g = new THREE.Group();
  const head = Math.min(0.2, len * 0.4), shaft = Math.max(0.01, len - head), mat = overlayMat(color);
  const s = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, shaft, 10), mat);
  s.position.y = shaft / 2;
  const c = new THREE.Mesh(new THREE.ConeGeometry(0.08, head, 16), mat);
  c.position.y = shaft + head / 2;
  g.add(s, c);
  g.position.copy(v3(from));
  g.quaternion.setFromUnitVectors(UP, v3(dir).normalize());
  return g;
}

function label(text, pos, color = '#ffffff') {
  const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
  const font = 'bold 44px "Noto Sans KR", "Malgun Gothic", sans-serif';
  ctx.font = font;
  cv.width = Math.ceil(ctx.measureText(text).width) + 28;
  cv.height = 64;
  ctx.font = font;
  ctx.fillStyle = 'rgba(10,14,28,0.78)';
  ctx.beginPath(); ctx.roundRect(0, 0, cv.width, cv.height, 14); ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 14, cv.height / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false }));
  const h = 0.2;
  sp.scale.set(h * cv.width / cv.height, h, 1);
  sp.position.copy(v3(pos));
  return sp;
}

function marker(pos, color, r = 0.06) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), overlayMat(color));
  m.position.copy(v3(pos));
  return m;
}

function supportArea(hull, y, color) {
  const g = new THREE.Group();
  const pts = hull.map(([x, z]) => new THREE.Vector3(x, y, z));
  if (hull.length >= 3) {
    const shape = new THREE.Shape(hull.map(([x, z]) => new THREE.Vector2(x, -z)));
    const fill = new THREE.Mesh(new THREE.ShapeGeometry(shape), overlayMat(color, 0.5));
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = y;
    g.add(fill);
    pts.push(pts[0]);
  }
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true })));
  return g;
}

function dashed(a, b, color) {
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v3(a), v3(b)]),
    new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.06, depthTest: false, transparent: true }));
  l.computeLineDistances();
  return l;
}

const forceLen = (f, ref) => Math.max(0.35, Math.min(1.4, 1.2 * f / ref));

export function createReportVisual(rep) {
  const g = new THREE.Group();
  const d = rep.detail;
  if (!d || rep.mode === 'removed') return g;
  const y = d.y0 + 0.01;
  const edge = d.edge && [d.edge[0], y, d.edge[1]], cen = d.c && [d.c[0], y, d.c[1]];   // 기저면·돌림힘만 있음

  if (rep.key === 'bos') {
    const [cx, cy, cz] = d.com, foot = [cx, y, cz];
    g.add(supportArea(d.hull, y, 0x3ddc84));
    g.add(label('지지면', [d.c[0] - 0.15, y - 0.22, d.c[1] + 0.55], '#3ddc84'));
    g.add(marker(d.com, 0xff4d4d, 0.08), label('무게중심 CoM', [cx + 0.45, cy + 0.15, cz], '#ff8080'));
    g.add(dashed(d.com, foot, 0xff4d4d), marker(foot, 0xff4d4d, 0.05));
    const L = forceLen(d.W, d.W);
    g.add(arrow([cx + 0.02, cy, cz], [0, -1, 0], Math.min(L, Math.max(0.35, cy - y)), 0xff4d4d));
    g.add(label(`W = ${f1(d.W)} N`, [cx - 0.5, cy - 0.3, cz], '#ff8080'));
    if (d.e > 0.04) {
      g.add(arrow(cen, [cx - cen[0], 0, cz - cen[2]], d.e, 0xffb347));
      g.add(label(`e = ${f2(d.e)} m`, [(cen[0] + cx) / 2 + 0.25, y - 0.2, (cen[2] + cz) / 2 + 0.45], '#ffb347'));
    }
    g.add(marker(edge, 0xffe066, 0.045));
  } else if (rep.key === 'torque') {
    const P = [d.P[0], y, d.P[1]];
    const Fd = v3(d.F).normalize(), L = forceLen(d.Fv, d.Fv);
    g.add(supportArea(d.hull, y, 0xffe066));
    g.add(arrow(P.map((v, i) => v - Fd.getComponent(i) * L), Fd.toArray(), L, 0xff4d4d));
    g.add(label(`F = ${f1(d.Fv)} N`, [P[0] + 0.35, P[1] + L * 0.7, P[2]], '#ff8080'));
    g.add(marker(P, 0xff4d4d, 0.05));
    if (d.e > 0.04) {
      g.add(arrow(cen, [P[0] - cen[0], 0, P[2] - cen[2]], d.e, 0xffb347));
      g.add(label(`r = ${f2(d.e)} m`, [(cen[0] + P[0]) / 2, y - 0.15, (cen[2] + P[2]) / 2], '#ffb347'));
    }
    // 회전 방향 화살표: 축 = r × F (오른손 법칙)
    const axis = new THREE.Vector3(P[0] - cen[0], 0, P[2] - cen[2]).cross(v3(d.F));
    if (axis.lengthSq() > 1e-8) {
      axis.normalize();
      const R = 0.32, arc = Math.PI * 1.4, mat = overlayMat(0xffb347, 0.9);
      const ring = new THREE.Group();
      ring.add(new THREE.Mesh(new THREE.TorusGeometry(R, 0.022, 8, 40, arc), mat));
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 14), mat);
      head.position.set(R * Math.cos(arc), R * Math.sin(arc), 0);
      head.quaternion.setFromUnitVectors(UP, new THREE.Vector3(-Math.sin(arc), Math.cos(arc), 0));
      ring.add(head);
      ring.position.set(edge[0], y + 0.15, edge[2]);
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
      g.add(ring);
    }
    g.add(marker(edge, 0xffe066, 0.05));
    g.add(label(`Στ = ${f2(d.Mo)} > ${f2(d.Mr)} N·m`, [edge[0], y + 0.62, edge[2]], '#ffb347'));
  } else {
    const O = d.O, n = d.nUp, t = v3(d.Ftv).normalize().toArray();
    const fs = d.mu * d.Fn, big = Math.max(d.Ft, fs, 1e-6);
    g.add(arrow(O, n, 0.8, 0x5fa8ff));
    g.add(label(`N = ${f1(d.Fn)} N`, [O[0] + n[0] * 0.95, O[1] + n[1] * 0.95 + 0.1, O[2] + n[2] * 0.95], '#8cc4ff'));
    const LF = Math.max(0.3, 1.2 * d.Ft / big), Lf = Math.max(0.2, 1.2 * fs / big);
    g.add(arrow(O, t, LF, 0xff4d4d));
    g.add(label(`전단력 F = ${f2(d.Ft)} N`, [O[0] + t[0] * (LF + 0.45), O[1] + 0.12, O[2] + t[2] * (LF + 0.45)], '#ff8080'));
    g.add(arrow(O, t.map(v => -v), Lf, 0x3ddc84));
    g.add(label(`μN = ${f2(fs)} N`, [O[0] - t[0] * (Lf + 0.4), O[1] - 0.12, O[2] - t[2] * (Lf + 0.4)], '#3ddc84'));
    g.add(marker(O, 0xffffff, 0.04));
  }
  g.traverse(o => { o.renderOrder = 50; });
  return g;
}

export function disposeVisual(g) {
  g.traverse(o => {
    o.geometry?.dispose();
    if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
  });
}
