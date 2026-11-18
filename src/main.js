// 앱 진입점: 장면 구성, 게임 루프, 게임 흐름 (대기 → 카운트다운 → 2분 게임 ⇄ 붕괴 리포트 → 종료 → 명예의 전당)
import * as THREE from 'three';
import { Physics, FIXED_DT, UNIT, PLATFORM_HALF, randomType } from './physics.js';
import { Analyzer, CAUSES, describeReport, createReportVisual, disposeVisual } from './analyzer.js';
import { InputManager } from './sensor.js';
import * as db from './database.js';
import { UI } from './ui.js';

const GAME_TIME = 120;          // 타임어택 (s)
const REPORT_SECONDS = 10;      // 공학 리포트 자동 닫힘 (s)
const GRAB_RANGE = 0.3;         // 손과 블록 표면 사이 잡을 수 있는 거리 (m)
const GRAB_WINDOW = 0.35;       // 손을 쥔 뒤 이 시간 안에 블록에 닿아 있어야 잡힘 (s)
const SLOT_X = 2.3, SLOT_Z = 0.4, SLOT_REFILL = 0.6;   // 새 블록 받침대 위치, 다시 채우는 시간
const ROTATE_STEP = Math.PI / 4;
const HINTS = {
  mouse: '<b>왼쪽 버튼 누르고 있기</b> 잡기 · <b>떼기</b> 놓기 · <b>휠 / W·S</b> 앞뒤 · <b>Q·E</b> 회전',
  hand: '<b>주먹 쥐기</b> 잡기 · <b>손 펴기</b> 놓기 · <b>손을 화면 쪽으로 내밀기</b> 안쪽 · <b>당기기</b> 앞쪽',
};

// ── 렌더러 · 장면 ───────────────────────────────────────────
const canvas = document.getElementById('scene');
const TEST = new URLSearchParams(location.search).has('test');     // 헤드리스 테스트: 스크린샷용으로 그린 화면을 유지
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: TEST });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b1020, 16, 40);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 4, 10);

scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x1a1a2e, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 7, bottom: -7, near: 1, far: 40 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.6, 16, 6),
  new THREE.MeshStandardMaterial({ color: 0x1b2133, roughness: 0.9 }));
pillar.position.y = -0.6 - 8;
scene.add(pillar);

const physics = new Physics(scene);
const analyzer = new Analyzer(physics);
const sensor = new InputManager(canvas, camera, !TEST);
const ui = new UI();

function textSprite(text, color = '#cfe8ff', h = 0.17) {
  const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
  const font = 'bold 40px "Noto Sans KR", "Malgun Gothic", sans-serif';
  ctx.font = font;
  cv.width = Math.ceil(ctx.measureText(text).width) + 8;
  cv.height = 52;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 4, 28);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(h * cv.width / cv.height, h, 1);
  return sp;
}

// 층수 눈금자 (플랫폼 왼쪽 뒤)
(function makeRuler(floors = 40) {
  const g = new THREE.Group();
  g.position.set(-PLATFORM_HALF - 0.3, 0, -PLATFORM_HALF + 0.2);
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.04, floors * UNIT, 0.04),
    new THREE.MeshBasicMaterial({ color: 0x5fd4ff, transparent: true, opacity: 0.5 }));
  pole.position.y = floors * UNIT / 2;
  g.add(pole);
  const tick = new THREE.BoxGeometry(0.16, 0.012, 0.012), tickMat = new THREE.MeshBasicMaterial({ color: 0x5fd4ff });
  for (let i = 1; i <= floors; i++) {
    const t = new THREE.Mesh(tick, tickMat);
    t.position.set(0.06, i * UNIT, 0);
    const s = textSprite(`${i}층`);
    s.position.set(-0.28, i * UNIT, 0);
    g.add(t, s);
  }
  scene.add(g);
})();

// 최고 기록 높이 표시 (플랫폼 둘레 사각 테두리)
const bestMarker = new THREE.Group();
{
  const s = PLATFORM_HALF + 0.1;
  const pts = [[-s, -s], [s, -s], [s, s], [-s, s], [-s, -s]].map(([x, z]) => new THREE.Vector3(x, 0, z));
  bestMarker.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.8 })));
  bestMarker.visible = false;
  scene.add(bestMarker);
}
let bestLabel = null;
function setBestMarker(floor) {
  bestMarker.visible = floor > 0;
  bestMarker.position.y = floor * UNIT;
  if (bestLabel) { bestMarker.remove(bestLabel); bestLabel.material.map.dispose(); bestLabel.material.dispose(); }
  bestLabel = textSprite(`최고 ${floor.toFixed(1)}층`, '#ffd34d', 0.2);
  bestLabel.position.set(PLATFORM_HALF + 0.55, 0.14, -PLATFORM_HALF - 0.1);
  bestMarker.add(bestLabel);
}

// ── 가상 손 ─────────────────────────────────────────────────
function buildHand(mat) {
  const g = new THREE.Group(), joints = [];
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 0.07), mat));
  const seg = (len) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.027, len, 4, 8), mat);
    m.position.y = len / 2;
    return m;
  };
  for (const [x, len] of [[-0.085, 0.1], [-0.03, 0.12], [0.03, 0.115], [0.085, 0.095]]) {
    const k1 = new THREE.Group(), k2 = new THREE.Group();
    k1.position.set(x, 0.13, 0);
    k2.position.y = len * 0.55 + 0.01;
    k1.add(seg(len * 0.55), k2);
    k2.add(seg(len * 0.45));
    g.add(k1);
    joints.push(k1, k2);
  }
  const t1 = new THREE.Group(), t2 = new THREE.Group();
  t1.position.set(-0.12, -0.04, 0.01);
  t1.rotation.z = 0.8;
  t2.position.y = 0.07;
  t1.add(seg(0.06), t2);
  t2.add(seg(0.05));
  g.add(t1);
  g.scale.setScalar(1.5);
  return {
    g,
    setCurl(c) {
      for (const j of joints) j.rotation.x = -c * 1.25;
      t1.rotation.x = -c * 0.6;
      t2.rotation.x = -c * 0.9;
    },
  };
}
const handMat = new THREE.MeshStandardMaterial({ color: 0x86e1ff, emissive: 0x1c5a78, roughness: 0.4, transparent: true, opacity: 0.9 });
const ghostMat = new THREE.MeshBasicMaterial({ color: 0x86e1ff, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false });
const handSolid = buildHand(handMat), handGhost = buildHand(ghostMat);   // 고스트: 블록 뒤에 가려져도 보이게
handGhost.g.traverse(o => { o.renderOrder = 40; });
scene.add(handSolid.g, handGhost.g);
const HAND_COLORS = { idle: 0x86e1ff, hover: 0xffd34d, hold: 0x5dff9d };

// 손 아래 낙하 지점 안내 (점선 + 고리)
const guideLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineDashedMaterial({ color: 0x86e1ff, dashSize: 0.1, gapSize: 0.08, transparent: true, opacity: 0.7 }));
const guideRing = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40),
  new THREE.MeshBasicMaterial({ color: 0x86e1ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
guideRing.rotation.x = -Math.PI / 2;
scene.add(guideLine, guideRing);
const raycaster = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);

// ── 새 블록 받침대 (좌우 2곳) ───────────────────────────────
const padGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.05, 32);
const slots = [-SLOT_X, SLOT_X].map(x => {
  const pad = new THREE.Mesh(padGeo, new THREE.MeshStandardMaterial({ color: 0x223355, emissive: 0x2a6fa8, emissiveIntensity: 0.8 }));
  scene.add(pad);
  return { x, pad, block: null, refillAt: 0, spawnT: 0 };
});
let slotY = 0.9;

// ── 게임 상태 ───────────────────────────────────────────────
let state = 'title';            // title | countdown | playing | report | over | entry
let clock = 0, remaining = GAME_TIME, cdLeft = 0;
let best = 0, curFloor = 0, towerTop = 0, lastFailure = null;
let bestAt = null, collapses = 0;        // 최고 층을 처음 쌓은 시간(게임 시작 후 초), 붕괴 횟수 → 게임 기록에 저장
let hovered = null, prevGrab = false, grabT = -9;
let rewind = null, reportVis = null, reportBlock = null, focus = null;
let titleTimer = null;
const gauges = { bos: 0, torque: 0, friction: 0 };
let uiTick = 0, hintSource = null;
const handCursor = document.getElementById('hand-cursor');

function setHover(b) {
  if (hovered === b) return;
  hovered?.setGlow(0);
  hovered = b;
}

function findCandidate(p) {
  let best = null, bestScore = GRAB_RANGE;
  for (const b of physics.blocks) {
    if (b.held) continue;
    const bb = physics.aabb(b), lo = bb.lowerBound, hi = bb.upperBound;
    const d = Math.hypot(Math.max(lo.x - p.x, 0, p.x - hi.x), Math.max(lo.y - p.y, 0, p.y - hi.y), Math.max(lo.z - p.z, 0, p.z - hi.z));
    const score = d + 0.001 * b.body.position.distanceTo(p);
    if (score < bestScore) { best = b; bestScore = score; }
  }
  return best;
}

function grabBlock(b, pos) {
  for (const s of slots) if (s.block === b) { s.block = null; s.refillAt = clock + SLOT_REFILL; b.mesh.scale.setScalar(1); }
  analyzer.noteGrab(b);
  physics.grab(b, pos);
}

function updateHand(dt, hand) {
  const show = hand.visible;
  handSolid.g.visible = handGhost.g.visible = show;
  const canControl = state === 'playing';
  const grabEdge = hand.grab && !prevGrab;
  if (grabEdge) grabT = clock;
  prevGrab = hand.grab;

  // 손 인식일 때 메뉴 버튼(시작·계속하기·키패드 등): 화면 커서를 버튼 위에 두고 주먹을 쥐면 누름
  const menu = sensor.source === 'hand' && hand.visible && state !== 'playing' && state !== 'countdown';
  handCursor.classList.toggle('show', menu);
  if (menu) {
    const g = sensor.hand.info.menu_gain || 1, cl = (v) => Math.max(-1, Math.min(1, v * g));   // 메뉴는 커서를 더 크게
    const x = (cl(hand.ndc.x) + 1) / 2 * innerWidth * 0.98 + innerWidth * 0.01;
    const y = (1 - cl(hand.ndc.y)) / 2 * innerHeight * 0.98 + innerHeight * 0.01;
    handCursor.style.transform = `translate(${x}px, ${y}px)`;
    handCursor.classList.toggle('grab', hand.grab);
    ui.hoverAt(x, y);
    if (grabEdge) ui.pressAt(x, y);
  }

  let mode = 'idle';
  if (canControl && physics.held) {
    physics.setHoldTarget(hand.pos, dt);
    if (!hand.grab) physics.release();
    else mode = 'hold';
  } else if (canControl) {
    const c = findCandidate(hand.pos);
    setHover(c);
    if (c) {
      if (hand.grab && clock - grabT < GRAB_WINDOW) { setHover(null); grabBlock(c, hand.pos); mode = 'hold'; }
      else { mode = 'hover'; c.setGlow(Math.sin(clock * 10) > 0 ? 0x5a4a00 : 0x2a2200); }
    }
  } else setHover(null);

  const curl = handSolid.g.userData.curl ?? 0;
  const target = hand.grab ? 1 : 0;
  const c = curl + (target - curl) * Math.min(1, dt * 14);
  handSolid.g.userData.curl = c;
  for (const h of [handSolid, handGhost]) {
    h.setCurl(c);
    h.g.position.set(hand.pos.x, hand.pos.y + 0.02, hand.pos.z + 0.25);
  }
  handMat.color.setHex(HAND_COLORS[mode]);
  ghostMat.color.setHex(HAND_COLORS[mode]);
}

// 손(또는 잡은 블록) 바로 아래 착지 지점
function updateGuide(hand) {
  const show = hand.visible && (state === 'playing' || state === 'countdown');
  guideLine.visible = guideRing.visible = show;
  if (!show) return;
  const held = physics.held;
  const from = held ? held.mesh.position.clone() : hand.pos.clone();
  let radius = 0.18;
  if (held) {
    const bb = physics.aabb(held);
    from.y = bb.lowerBound.y;
    radius = Math.max(bb.upperBound.x - bb.lowerBound.x, bb.upperBound.z - bb.lowerBound.z) / 2;
  }
  const targets = [physics.platformMesh];
  for (const b of physics.blocks) if (b.inWorld && !b.held) targets.push(b.mesh);
  raycaster.set(from, DOWN);
  const hit = raycaster.intersectObjects(targets, true).find(h => h.object.isMesh);
  const y = hit ? hit.point.y : -0.6;
  const pos = guideLine.geometry.attributes.position;
  pos.setXYZ(0, from.x, from.y, from.z);
  pos.setXYZ(1, from.x, y, from.z);
  pos.needsUpdate = true;
  guideLine.computeLineDistances();
  guideRing.position.set(from.x, y + 0.01, from.z);
  guideRing.scale.setScalar(radius);
  guideRing.material.color.setHex(held ? HAND_COLORS.hold : HAND_COLORS.idle);
}

function updateSlots(dt) {
  slotY += (Math.max(0.9, towerTop + 0.45) - slotY) * Math.min(1, dt * 2);
  const active = state === 'countdown' || state === 'playing';
  for (const s of slots) {
    if (!s.block && active && clock >= s.refillAt) {
      s.block = physics.createBlock(randomType());
      s.spawnT = clock;
    }
    const b = s.block;
    let half = 0.25;
    if (b) {
      const y = slotY + Math.sin(clock * 2 + s.x) * 0.05;
      b.body.position.set(s.x, y, SLOT_Z);
      b.body.quaternion.setFromEuler(0, clock * 0.6 + s.x, 0);
      b.mesh.position.copy(b.body.position);
      b.mesh.quaternion.copy(b.body.quaternion);
      b.mesh.scale.setScalar(Math.min(1, (clock - s.spawnT) / 0.3));
      const bb = physics.aabb(b);
      half = y - bb.lowerBound.y;
    }
    s.pad.position.set(s.x, slotY - half - 0.12, SLOT_Z);
    s.pad.visible = state !== 'title';
  }
}

// ── 카메라: 탑 높이를 따라 올라가고, 리포트 때는 원인 지점을 비춤 ──
const camLook = new THREE.Vector3(0, 1.4, 0);
let camTop = 0, viewShift = 0;
function updateCamera(dt) {
  camTop += (towerTop - camTop) * Math.min(1, dt * 1.5);
  let lookY = Math.max(1.4, 0.5 * camTop + 0.6), dist = 9 + Math.max(0, camTop - 5) * 0.6;
  const look = new THREE.Vector3(0, lookY, 0);
  if (state === 'report' && focus) { look.copy(focus); dist = Math.max(6.5, dist * 0.75); lookY = focus.y; }
  const want = new THREE.Vector3(look.x, lookY + 1.8 + dist * 0.1, look.z + dist);
  const k = Math.min(1, dt * 2.5);
  camera.position.lerp(want, k);
  camLook.lerp(look, k);
  camera.lookAt(camLook);
  sun.position.set(4, camLook.y + 9, 6);
  sun.target.position.set(0, camLook.y - 1, 0);
  // 리포트 팝업이 왼쪽을 가리므로 화면을 오른쪽으로 밀어 줌
  viewShift += ((state === 'report' && !rewind ? 0.17 : 0) - viewShift) * Math.min(1, dt * 4);
  if (viewShift > 0.002) camera.setViewOffset(innerWidth, innerHeight, -viewShift * innerWidth, 0, innerWidth, innerHeight);
  else camera.clearViewOffset();
}

// ── 붕괴 리포트 ─────────────────────────────────────────────
const ease = (k) => k * k * (3 - 2 * k);
function startReport(rep) {
  state = 'report';
  lastFailure = CAUSES[rep.key].name;
  collapses++;
  setHover(null);
  physics.sync();
  ui.flash();
  ui.setHint('');
  startRewind(rep.entry.poses, 0.9, () => showReport(rep));
}

// 화면의 블록 자세를 목표 자세(poses: id → [x,y,z,qx,qy,qz,qw])로 부드럽게 옮김. 물리는 멈춘 상태
function startRewind(to, dur, onDone) {
  const from = new Map();
  for (const b of physics.blocks) if (b.inWorld) from.set(b.id, [b.mesh.position.clone(), b.mesh.quaternion.clone()]);
  rewind = { t: 0, dur, from, to, onDone };
}

function updateRewind(dt) {
  rewind.t += dt;
  const k = ease(Math.min(1, rewind.t / rewind.dur));
  const tp = new THREE.Vector3(), tq = new THREE.Quaternion();
  for (const b of physics.blocks) {
    const a = rewind.from.get(b.id), p = rewind.to.get(b.id);
    if (!a || !p) continue;
    b.mesh.position.lerpVectors(a[0], tp.set(p[0], p[1], p[2]), k);
    b.mesh.quaternion.slerpQuaternions(a[1], tq.set(p[3], p[4], p[5], p[6]), k);
  }
  if (k < 1) return;
  const done = rewind.onDone;
  rewind = null;
  done();
}

// 임계치를 처음 넘은 순간으로 되감은 화면 위에 벡터 화살표와 리포트 팝업
function showReport(rep) {
  const d = rep.detail;
  reportBlock = d ? [...physics.blocks].find(b => b.body.id === d.id) || null : null;
  reportBlock?.setGlow(0x7a1a1a);
  reportVis = createReportVisual(rep);
  scene.add(reportVis);
  if (d) {
    focus = rep.key === 'bos' ? new THREE.Vector3(d.com[0], (d.com[1] + d.y0) / 2, d.com[2])
      : rep.key === 'torque' ? new THREE.Vector3(d.P[0], d.y0, d.P[1]) : new THREE.Vector3(...d.O);
  }
  const typeName = reportBlock ? reportBlock.def.name : '';
  ui.showReport(describeReport(rep, typeName), rep, REPORT_SECONDS, endReport);
}

// 리포트를 닫으면 실제(붕괴 감지 시점) 자세로 돌아가 이어서 진행. 남은 탑은 그대로 두고 계속 쌓음
function endReport() {
  if (reportVis) { scene.remove(reportVis); disposeVisual(reportVis); reportVis = null; }
  reportBlock?.setGlow(0);
  reportBlock = null;
  focus = null;
  const now = new Map();
  for (const b of physics.blocks) {
    if (!b.inWorld) continue;
    const p = b.body.position, q = b.body.quaternion;
    now.set(b.id, [p.x, p.y, p.z, q.x, q.y, q.z, q.w]);
  }
  startRewind(now, 0.35, () => {
    analyzer.resume();
    state = 'playing';
    hintSource = null;
  });
}

// ── 게임 흐름 ───────────────────────────────────────────────
function resetRound() {
  clearTimeout(titleTimer);
  physics.clearAll();
  for (const s of slots) { s.block = null; s.refillAt = 0; }
  analyzer.reset();
  best = curFloor = towerTop = 0;
  remaining = GAME_TIME;
  lastFailure = null;
  bestAt = null;
  collapses = 0;
  setBestMarker(0);
  ui.setTimer(remaining);
  ui.setFloors(0, 0);
}

function toTitle() {
  resetRound();
  for (const id of ['gameover', 'keypad', 'report', 'countdown']) ui.show(id, false);
  state = 'title';
  ui.show('title');
  ui.setHint('');
  db.fetchTop().then(rows => ui.renderLeaderboard(rows));
}

function startGame() {
  if (state !== 'title') return;
  resetRound();
  ui.show('title', false);
  state = 'countdown';
  cdLeft = 3.8;
  sensor.hand.startCalibration();
}

async function endGame() {
  state = 'over';
  physics.release();            // 조작 차단: 잡고 있던 블록은 놓음
  setHover(null);
  ui.setTimer(0);
  ui.setHint('');
  const final = best, reason = lastFailure;
  ui.showGameOver({ title: 'TIME UP!', floor: final, reason, msg: '기록을 저장하는 중…' });
  // 모든 게임을 기록 (이름 없이) → TOP 4에 들면 이름 입력
  const save = db.savePlay({ max_floor: final, failure_reason: reason, best_time_s: bestAt, collapses, duration_s: GAME_TIME })
    .catch((e) => { console.error(e); return null; });
  const [play] = await Promise.all([save, new Promise(r => setTimeout(r, 2500))]);
  if (state !== 'over') return;                         // 그 사이 처음으로 돌아감
  if (!play) {
    ui.showGameOver({ title: 'TIME UP!', floor: final, reason, msg: '기록을 저장하지 못했습니다 (서버 연결 확인)',
      button: { text: '처음으로', onClick: toTitle } });
    titleTimer = setTimeout(toTitle, 10000);
  } else if (play.qualifies) {
    ui.show('gameover', false);
    state = 'entry';
    ui.openKeypad(final, play.rank, async (name) => {
      if (!name) { toTitle(); return; }                  // 오래 입력이 없으면 이름 없이 두고 처음으로
      const res = await db.setName(play.id, name).catch((e) => { console.error(e); return null; });
      state = 'over';
      if (res) ui.renderLeaderboard(res.top, res.id);
      ui.showGameOver({ title: res ? `명예의 전당 ${res.rank}위!` : 'TIME UP!', floor: final, reason,
        msg: res ? `${name} 님의 기록이 저장되었습니다.` : '이름을 저장하지 못했습니다 (서버 연결 확인)',
        button: { text: '처음으로', onClick: toTitle } });
      titleTimer = setTimeout(toTitle, 12000);
    });
  } else {
    const top = await db.fetchTop();
    const cut = top.length >= db.TOP_N ? `TOP ${db.TOP_N} 진입 기준: ${top[db.TOP_N - 1].max_floor.toFixed(1)}층 초과` : '';
    ui.showGameOver({ title: 'TIME UP!', floor: final, reason, msg: cut, button: { text: '처음으로', onClick: toTitle } });
    titleTimer = setTimeout(toTitle, 10000);
  }
}

// ── 데이터 보기 (운영자용) ───────────────────────────────────
async function openData() {
  try {
    ui.showData(await db.fetchPlays(), async (id) => {
      try {
        const res = await db.deletePlay(id);
        ui.renderLeaderboard(res.top);
        openData();
      } catch (e) { alert(`삭제하지 못했습니다: ${e.message}`); }
    });
  } catch (e) { alert(`데이터를 불러오지 못했습니다: ${e.message}`); }
}
document.getElementById('btn-data').onclick = openData;
document.getElementById('dv-close').onclick = () => ui.show('data-view', false);

function updateGame(dt) {
  if (state === 'countdown') {
    cdLeft -= dt;
    ui.countdown(cdLeft > 0.8 ? String(Math.ceil(cdLeft - 0.8)) : cdLeft > 0 ? '시작!' : '',
      sensor.hand.available ? '손을 편하게 앞으로 내밀어 주세요 — 지금 손 거리가 기준이 됩니다' : '');
    if (cdLeft <= 0) {
      state = 'playing';
      hintSource = null;
      sensor.hand.finishCalibration();
    }
  } else if (state === 'playing') {
    remaining -= dt;
    if (remaining <= 0) { remaining = 0; endGame(); }
    if (hintSource !== sensor.source) { hintSource = sensor.source; ui.setHint(HINTS[hintSource]); }
  }
  if (uiTick % 30 === 0) ui.setInputStatus(sensor.hand.info, sensor.hand.available, sensor.source);
  if (++uiTick % 4 === 0 && state !== 'title') {
    ui.setTimer(remaining);
    ui.setFloors(curFloor, best);
    ui.setGauges(gauges);
  }
}

function onAnalysis(r) {
  towerTop = r.top;
  curFloor = r.floor;
  if (r.stableFloor > best) { best = r.stableFloor; bestAt = Math.round((GAME_TIME - remaining) * 10) / 10; setBestMarker(best); }
  for (const k in gauges) gauges[k] += (r.ratios[k] - gauges[k]) * 0.25;
  if (r.report) startReport(r.report);
}

// ── 메인 루프 ───────────────────────────────────────────────
let last = null, acc = 0, steps = 0, manual = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = last === null ? 0 : Math.min(0.05, Math.max(0, (now - last) / 1000));   // rAF 시각이 앞뒤로 튀어도 안전하게
  last = now;
  if (manual) return;
  simulate(dt);
  renderer.render(scene, camera);
}

function simulate(dt) {
  clock += dt;
  const hand = sensor.read();
  updateHand(dt, hand);
  if (state === 'report') {
    if (rewind) updateRewind(dt);
  } else {
    acc += dt;
    let n = 0;
    while (acc >= FIXED_DT && n < 8) {
      acc -= FIXED_DT;
      n++;
      physics.step(FIXED_DT);
      if (state === 'playing' && ++steps % 2 === 0) {
        onAnalysis(analyzer.update(2 * FIXED_DT));
        if (state === 'report') break;
      }
    }
    if (n >= 8) acc = 0;
    if (state !== 'report') physics.sync();
  }
  updateSlots(dt);
  updateGame(dt);
  updateGuide(hand);
  updateCamera(dt);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
addEventListener('keydown', (e) => {
  if (e.code === 'KeyQ' && physics.held) physics.rotateHeld(ROTATE_STEP);
  if (e.code === 'KeyE' && physics.held) physics.rotateHeld(-ROTATE_STEP);
  if (e.code === 'Escape') ui.show('data-view', false);
  if (ui.dataOpen) return;                // 데이터 보기 중에는 게임 단축키 무시
  if (e.code === 'Enter' && state === 'title') startGame();
  if (e.code === 'KeyV') ui.togglePreview();
});
document.getElementById('btn-start').onclick = startGame;

toTitle();
requestAnimationFrame(frame);

// 테스트·디버그용 (브라우저 콘솔에서 window.chaos 로 접근)
// advance(초): 화면 프레임과 무관하게 게임 시간을 직접 진행 (헤드리스 테스트용, 호출 뒤에는 자동 루프가 멈춤)
window.chaos = {
  physics, analyzer, sensor, ui, camera, Vector3: THREE.Vector3,
  get state() { return state; }, get best() { return best; }, startGame, endGame,
  advance(sec) {
    manual = true;
    for (let t = 0; t < sec - 1e-9; t += 1 / 60) simulate(1 / 60);
    renderer.render(scene, camera);
  },
  live() { manual = false; },
};
