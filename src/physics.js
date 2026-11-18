// 물리 모듈: cannon-es 월드, 블록 종류와 메시 풀, 손으로 잡기/놓기, 접촉력 기록
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const G = 9.8;                   // 중력 가속도 (m/s²)
export const UNIT = 0.5;                // 1층 = 기본 정육면체 높이 (m)
export const FIXED_DT = 1 / 120;        // 물리 고정 시간 간격 (s)
export const PLATFORM_HALF = 1.2;       // 플랫폼 윗면 2.4m × 2.4m, 윗면 높이 y = 0
const PLATFORM_MU = 1.0, PLATFORM_E = 0.5;   // 두 물체 사이 실제 μ·e = 두 재질 값의 곱
const FALL_REMOVE_Y = -8;               // 이보다 아래로 떨어진 블록은 제거
const HOLD_TAU = 0.06;                  // 잡은 블록이 손을 따라가는 시간상수 (s)
const HOLD_VMAX = 7;                    // 잡은 블록 최대 이동 속도 (m/s)
const THROW_VMAX = 4;                   // 놓을 때 최대 속도 (m/s)

// 블록 종류. mu, e는 재질 값이고 weight는 등장 비중.
// parts: box [가로, 높이, 깊이] | cyl [반지름, 높이] | ramp [가로, 왼쪽 높이, 오른쪽 높이, 깊이], at = 부품 위치
export const BLOCK_TYPES = {
  cube:     { name: '정육면체',  mass: 1.0, mu: 0.7,  e: 0.1,  color: 0xf2b134, weight: 5, parts: [{ box: [0.5, 0.5, 0.5] }] },
  plank:    { name: '널빤지',    mass: 1.2, mu: 0.7,  e: 0.1,  color: 0xc9844f, weight: 3, parts: [{ box: [1.3, 0.25, 0.45] }] },
  slab:     { name: '넓은 판',   mass: 1.8, mu: 0.7,  e: 0.1,  color: 0x7f9bb8, weight: 2, parts: [{ box: [0.9, 0.3, 0.9] }] },
  pillar:   { name: '기둥',      mass: 0.8, mu: 0.7,  e: 0.1,  color: 0xe8dcc4, weight: 2, parts: [{ box: [0.3, 0.9, 0.3] }] },
  cylinder: { name: '원기둥',    mass: 0.9, mu: 0.6,  e: 0.1,  color: 0x45c08a, weight: 3, parts: [{ cyl: [0.28, 0.5] }] },
  ramp:     { name: '경사 블록', mass: 0.9, mu: 0.7,  e: 0.1,  color: 0xe0605a, weight: 2, parts: [{ ramp: [0.7, 0.5, 0.15, 0.5] }] },
  lblock:   { name: 'ㄴ자 블록', mass: 1.3, mu: 0.7,  e: 0.1,  color: 0x9b6bd6, weight: 2,
              parts: [{ box: [0.9, 0.3, 0.45], at: [0, 0.15, 0] }, { box: [0.3, 0.6, 0.45], at: [-0.3, 0.6, 0] }] },
  ice:      { name: '얼음',      mass: 0.9, mu: 0.12, e: 0.05, color: 0xa9e4ff, weight: 2, opacity: 0.72, parts: [{ box: [0.5, 0.5, 0.5] }] },
  stone:    { name: '무거운 돌', mass: 3.0, mu: 0.85, e: 0.05, color: 0x70757d, weight: 2, parts: [{ box: [0.55, 0.4, 0.55] }] },
};

export function randomType() {
  const keys = Object.keys(BLOCK_TYPES);
  let r = Math.random() * keys.reduce((s, k) => s + BLOCK_TYPES[k].weight, 0);
  for (const k of keys) { r -= BLOCK_TYPES[k].weight; if (r <= 0) return k; }
  return keys[0];
}

// 비대칭 경사 블록: 바닥은 직사각형, 윗면이 한쪽으로 기울어진 사다리꼴 기둥. 꼭짓점은 무게중심 기준
function rampPoly(w, hL, hR, d) {
  const a = w / 2, c = d / 2;
  const cx = -a + w * (hL + 2 * hR) / (3 * (hL + hR));
  const cy = (hL * hL + hL * hR + hR * hR) / (3 * (hL + hR));
  const v = [[-a, 0, -c], [a, 0, -c], [a, 0, c], [-a, 0, c], [-a, hL, -c], [a, hR, -c], [a, hR, c], [-a, hL, c]]
    .map(([x, y, z]) => [x - cx, y - cy, z]);
  const faces = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [3, 2, 6, 7], [0, 3, 7, 4], [1, 5, 6, 2]];   // 바깥에서 볼 때 반시계
  return { v, faces, vol: w * (hL + hR) / 2 * d };
}

function polyGeometry(v, faces) {
  const pos = [];
  for (const f of faces) for (let i = 1; i < f.length - 1; i++) pos.push(...v[f[0]], ...v[f[i]], ...v[f[i + 1]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// 부품 하나: 부피, 물리 모양 생성기, 그래픽 형상 (부품 중심이 원점)
function partInfo(p) {
  if (p.box) {
    const [x, y, z] = p.box;
    return { vol: x * y * z, shape: () => new CANNON.Box(new CANNON.Vec3(x / 2, y / 2, z / 2)), geo: new THREE.BoxGeometry(x, y, z) };
  }
  if (p.cyl) {
    const [r, h] = p.cyl;
    return { vol: Math.PI * r * r * h, shape: () => new CANNON.Cylinder(r, r, h, 16), geo: new THREE.CylinderGeometry(r, r, h, 16) };
  }
  const { v, faces, vol } = rampPoly(...p.ramp);
  return { vol, shape: () => new CANNON.ConvexPolyhedron({ vertices: v.map(a => new CANNON.Vec3(...a)), faces }), geo: polyGeometry(v, faces) };
}

// 종류별 형상·재질은 한 번만 만들어 공유
const typeCache = new Map();
function typeInfo(key) {
  if (typeCache.has(key)) return typeCache.get(key);
  const def = BLOCK_TYPES[key];
  const parts = def.parts.map(p => ({ ...partInfo(p), at: p.at || [0, 0, 0] }));
  const vol = parts.reduce((s, p) => s + p.vol, 0);
  const c = [0, 1, 2].map(i => parts.reduce((s, p) => s + p.vol * p.at[i], 0) / vol);   // 무게중심 = 부피 가중 평균
  for (const p of parts) {
    p.off = p.at.map((a, i) => a - c[i]);     // 몸체 원점 = 무게중심
    p.edges = new THREE.EdgesGeometry(p.geo, 25);
  }
  const info = { def, parts, material: new CANNON.Material({ friction: def.mu, restitution: def.e }) };
  typeCache.set(key, info);
  return info;
}

export class Block {
  constructor(id, type, body, mesh) {
    Object.assign(this, { id, type, body, mesh });
    this.def = BLOCK_TYPES[type];
    this.inWorld = false;     // 받침대 위에 떠 있는 새 블록은 아직 물리 월드 밖
    this.held = false;
    this.still = 0;           // 멈춰 있는 시간 (s), 분석기가 사용
  }
  setGlow(hex) { this.mesh.userData.mat.emissive.setHex(hex); }
}

const pairKey = (a, b) => (a.id < b.id ? a.id * 1048576 + b.id : b.id * 1048576 + a.id);
const resting = (b) => b.type === CANNON.Body.STATIC || b.sleepState === CANNON.Body.SLEEPING;
const muOf = (a, b) => (a.material?.friction ?? 0.3) * (b.material?.friction ?? 0.3);

export class Physics {
  constructor(scene) {
    this.scene = scene;
    const world = this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -G, 0), allowSleep: true });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 30;
    world.solver.tolerance = 1e-6;
    const cm = world.defaultContactMaterial;
    cm.contactEquationStiffness = 1e8; cm.contactEquationRelaxation = 3;
    cm.frictionEquationStiffness = 1e8; cm.frictionEquationRelaxation = 3;

    this.blocks = new Set();
    this.nextId = 1;
    this.pool = new Map();        // 종류별로 반납된 메시
    this.pairs = new Map();       // 물체 쌍별 접촉 기록 (분석기 입력)
    this.held = null;
    this.holdTarget = new CANNON.Vec3();
    this.holdOffset = new CANNON.Vec3();
    this.holdYaw = 0;
    this._makePlatform();
    this._patchSolver();
  }

  _makePlatform() {
    const h = 0.6;
    const body = new CANNON.Body({ type: CANNON.Body.STATIC, material: new CANNON.Material({ friction: PLATFORM_MU, restitution: PLATFORM_E }) });
    body.addShape(new CANNON.Box(new CANNON.Vec3(PLATFORM_HALF, h / 2, PLATFORM_HALF)));
    body.position.set(0, -h / 2, 0);
    this.world.addBody(body);
    this.platform = body;

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(PLATFORM_HALF * 2, h, PLATFORM_HALF * 2),
      new THREE.MeshStandardMaterial({ color: 0x2b3245, roughness: 0.8 }));
    mesh.position.y = -h / 2;
    mesh.receiveShadow = true;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x5fd4ff })));
    const grid = new THREE.GridHelper(PLATFORM_HALF * 2, 8, 0x5fd4ff, 0x3a5a78);
    grid.position.y = h / 2 + 0.002;
    grid.material.transparent = true; grid.material.opacity = 0.35;
    mesh.add(grid);
    this.scene.add(mesh);
    this.platformMesh = mesh;
  }

  // ── 블록 생성 / 제거 (메시 풀) ─────────────────────────────
  createBlock(type) {
    const info = typeInfo(type);
    const body = new CANNON.Body({ mass: info.def.mass, material: info.material });
    for (const p of info.parts) body.addShape(p.shape(), new CANNON.Vec3(...p.off));
    body.sleepSpeedLimit = 0.1;
    body.sleepTimeLimit = 0.6;
    body.linearDamping = 0.02;
    body.angularDamping = 0.05;
    const blk = new Block(this.nextId++, type, body, this._acquireMesh(type));
    body.block = blk;
    this.blocks.add(blk);
    this.scene.add(blk.mesh);
    return blk;
  }

  _acquireMesh(type) {
    const free = this.pool.get(type);
    if (free?.length) return free.pop();
    const { def, parts } = typeInfo(type);
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.55, metalness: 0.05,
      transparent: !!def.opacity, opacity: def.opacity ?? 1 });
    const line = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
    for (const p of parts) {
      const m = new THREE.Mesh(p.geo, mat);
      m.position.set(...p.off);
      m.castShadow = m.receiveShadow = true;
      const e = new THREE.LineSegments(p.edges, line);
      e.position.set(...p.off);
      g.add(m, e);
    }
    g.userData.mat = mat;
    return g;
  }

  activate(blk) {
    if (blk.inWorld) return;
    this.world.addBody(blk.body);
    blk.inWorld = true;
  }

  removeBlock(blk) {
    if (this.held === blk) this.held = null;
    if (blk.inWorld) this.world.removeBody(blk.body);
    blk.inWorld = false;
    this.blocks.delete(blk);
    this.scene.remove(blk.mesh);
    blk.setGlow(0);
    blk.mesh.scale.setScalar(1);
    if (!this.pool.has(blk.type)) this.pool.set(blk.type, []);
    this.pool.get(blk.type).push(blk.mesh);
    this.wakeAll();
  }

  // 물리 월드에 들어간 블록 전부 제거 (받침대 위 새 블록은 남김)
  clearWorld() {
    for (const b of [...this.blocks]) if (b.inWorld) this.removeBlock(b);
    this.pairs.clear();
  }

  clearAll() {
    for (const b of [...this.blocks]) this.removeBlock(b);
    this.pairs.clear();
  }

  wakeAll() {
    for (const b of this.blocks) if (b.inWorld) b.body.wakeUp();
  }

  // ── 잡기 / 놓기 ───────────────────────────────────────────
  // 잡은 블록은 손의 자식처럼 손 위치를 따라가고(속도 제어 + 중력 상쇄), 놓으면 독립 강체로 돌아감
  grab(blk, handPos) {
    if (this.held) this.release();
    this.activate(blk);
    const b = blk.body;
    blk.held = true;
    this.held = blk;
    b.allowSleep = false;
    b.wakeUp();
    const e = new CANNON.Vec3();
    b.quaternion.toEuler(e);
    this.holdYaw = e.y;
    b.position.vsub(new CANNON.Vec3(handPos.x, handPos.y, handPos.z), this.holdOffset);
    this.holdTarget.copy(b.position);
    this.wakeAll();
  }

  setHoldTarget(handPos, dt) {
    this.holdOffset.scale(Math.exp(-dt / 0.15), this.holdOffset);   // 잡은 지점에서 손 중심으로 서서히 끌려옴
    this.holdTarget.set(handPos.x + this.holdOffset.x, handPos.y + this.holdOffset.y, handPos.z + this.holdOffset.z);
  }

  rotateHeld(dYaw) { this.holdYaw += dYaw; }

  release() {
    const blk = this.held;
    if (!blk) return null;
    const b = blk.body;
    blk.held = false;
    this.held = null;
    b.allowSleep = true;
    const s = b.velocity.length();
    if (s > THROW_VMAX) b.velocity.scale(THROW_VMAX / s, b.velocity);
    b.angularVelocity.scale(0.3, b.angularVelocity);
    this.wakeAll();
    return blk;
  }

  _driveHeld() {
    const b = this.held?.body;
    if (!b) return;
    const v = this.holdTarget.vsub(b.position).scale(1 / HOLD_TAU);
    const s = v.length();
    if (s > HOLD_VMAX) v.scale(HOLD_VMAX / s, v);
    b.velocity.copy(v);
    b.force.y += b.mass * G;                       // 중력 상쇄
    // 수평을 유지하면서 목표 방향(yaw)으로 회전
    const qT = new CANNON.Quaternion();
    qT.setFromEuler(0, this.holdYaw, 0);
    const q = qT.mult(b.quaternion.conjugate());
    if (q.w < 0) { q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w; }
    const sinHalf = Math.hypot(q.x, q.y, q.z);
    if (sinHalf < 1e-6) { b.angularVelocity.set(0, 0, 0); return; }
    const k = 2 * Math.atan2(sinHalf, q.w) / sinHalf / 0.12;
    b.angularVelocity.set(q.x * k, q.y * k, q.z * k);
  }

  // ── 시뮬레이션 ────────────────────────────────────────────
  step(dt) {
    this._driveHeld();
    this.world.step(dt);
    for (const b of this.blocks) if (b.inWorld && b.body.position.y < FALL_REMOVE_Y) this.removeBlock(b);
  }

  sync() {
    for (const b of this.blocks) {
      b.mesh.position.copy(b.body.position);
      b.mesh.quaternion.copy(b.body.quaternion);
    }
  }

  // 블록 AABB (물리 월드 밖에 있는 블록도 계산)
  aabb(blk) {
    const b = blk.body;
    if (b.aabbNeedsUpdate || !blk.inWorld) b.updateAABB();
    return b.aabb;
  }

  // ── 접촉력 기록과 쿨롱 마찰 보정 ─────────────────────────────
  _patchSolver() {
    const solver = this.world.solver;
    const solve = solver.solve.bind(solver);
    solver.solve = (dt, world) => {
      this._coulombLimits();
      const iters = solve(dt, world);
      this._recordContacts();
      return iters;
    };
  }

  // cannon-es 기본 마찰 한계는 μ·g·(환산질량)이라 위에 쌓인 무게가 반영되지 않는다.
  // 직전 스텝의 실제 수직항력 N으로 접촉점마다 최대 정지마찰력 μN을 적용 (첫 접촉은 기본값)
  _coulombLimits() {
    for (const fe of this.world.frictionEquations) {
      const rec = this.pairs.get(pairKey(fe.bi, fe.bj));
      if (!rec || !rec.pts.length) continue;
      const lim = rec.mu * rec.N / rec.pts.length;
      fe.maxForce = lim;
      fe.minForce = -lim;
    }
  }

  // 쌍마다: 접촉점(월드 좌표), a→b 법선, 수직항력 N(뉴턴), b가 받는 마찰력 합 F, 압력 중심 cop
  _recordContacts() {
    const next = new Map();
    for (const c of this.world.contacts) {
      const key = pairKey(c.bi, c.bj);
      let rec = next.get(key);
      if (!rec) {
        rec = { a: c.bi, b: c.bj, mu: muOf(c.bi, c.bj), N: 0, pts: [], F: [0, 0, 0], n: [0, 0, 0], cop: [0, 0, 0] };
        next.set(key, rec);
      }
      const s = c.bi === rec.a ? 1 : -1;
      const N = Math.max(0, c.multiplier);
      const p = c.bi.position, r = c.ri, n = c.ni;
      rec.pts.push({ p: [p.x + r.x, p.y + r.y, p.z + r.z], n: [n.x * s, n.y * s, n.z * s], N });
      rec.N += N;
    }
    for (const fe of this.world.frictionEquations) {
      const rec = next.get(pairKey(fe.bi, fe.bj));
      if (!rec) continue;
      const f = fe.bj === rec.b ? fe.multiplier : -fe.multiplier;
      rec.F[0] += f * fe.t.x; rec.F[1] += f * fe.t.y; rec.F[2] += f * fe.t.z;
    }
    for (const rec of next.values()) {
      const useN = rec.N > 1e-6;
      let wsum = 0;
      for (const pt of rec.pts) {
        const w = useN ? pt.N : 1;
        wsum += w;
        for (let i = 0; i < 3; i++) { rec.n[i] += w * pt.n[i]; rec.cop[i] += w * pt.p[i]; }
      }
      const nl = Math.hypot(...rec.n) || 1;
      for (let i = 0; i < 3; i++) { rec.n[i] /= nl; rec.cop[i] /= wsum; }
    }
    // 잠든 블록끼리는 접촉 계산이 생략되므로 마지막 기록을 유지
    for (const [key, rec] of this.pairs) {
      if (!next.has(key) && rec.a.world && rec.b.world && resting(rec.a) && resting(rec.b)) next.set(key, rec);
    }
    this.pairs = next;
  }
}
