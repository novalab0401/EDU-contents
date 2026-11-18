// 레이저 챌린지: 상태 흐름 · 점수 · 진단 · 그리기 연결.
//   title(대기·데모) → tutorial(MISSION 01) → tutorial_clear → brief(카운트다운) → play(MISSION 04 …)
//     → celebrate(성공) | review(실패: 정답 예시·처방) → card(결과·오늘의 챔피언) → title
import { LEVELS, levelById, cloneScene, SNAP, COLORS, W, H } from './levels.js';
import { trace, evaluate, lineDiff, norm180 } from './optics.js';
import { withAngles, diagnose, diagnosisText } from './solver.js';
import { LaserInput } from './input.js';
import { Sfx } from './audio.js';
import { WebHand } from './webhand.js';
import * as R_ from './render.js';

const { txt, panel, roundRect, drawBackground, drawObstacles, drawEmitter, drawMirror, drawTarget, drawPath, drawPrinciple, drawParticles, CYAN } = R_;

const Q = new URLSearchParams(location.search);
const MANUAL = Q.has('manual');            // 테스트: 시간을 직접 진행 (laser.advance)
const NO_HAND = Q.has('nohand') || MANUAL; // 손 인식 스트림에 연결하지 않음
// 손 인식은 기본적으로 브라우저 안에서 (웹캠 + MediaPipe WASM, 설치·opencv 불필요). ?server 를 붙이면 파이썬 서버(/hand, 오르벡 깊이 카메라)를 씀
const BROWSER_HAND = !NO_HAND && !Q.has('server') && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
const BEAM_SPEED = 2600;                   // 레이저가 나아가는 속도 (px/s) — 눈으로 따라갈 수 있는 빠르기
const SHOT_HOLD = 0.6;                     // 레이저가 끝까지 간 뒤 잠깐 머무는 시간
const BRIEF_SEC = 4.0, CLEAR_SEC = 1.8, CELEBRATE_SEC = 2.6, REVIEW_SEC = 7.0, CARD_IDLE_SEC = 25;
const TUTORIAL_MAX_SEC = 90;               // 튜토리얼이 너무 길어지면 자동으로 넘어감
const HAND_START_SEC = 1.0;                // 대기 화면에서 손(커서)이 난이도 카드 위에 이만큼 머물면 선택
// 처음 화면의 난이도 카드 (캔버스 좌표). 마우스 클릭 · 손 커서로 1초 머무르기 · 숫자 키 2~5
const MENU_Y = 448, MENU_W = 228, MENU_H = 122, MENU_GAP = 18, MENU_X0 = (1280 - (4 * 228 + 3 * 18)) / 2;
const MENU = [
  { key: '2', plan: [1, 2], name: '쉬움', sub: 'MISSION 02', desc: '타깃 2개', color: '#5dff9d' },
  { key: '3', plan: [1, 3], name: '보통', sub: 'MISSION 03', desc: '타깃 3개', color: '#4cf0ff' },
  { key: '4', plan: [1, 4], name: '어려움', sub: 'MISSION 04 · 추천', desc: '타깃 4개 · 거울 5개', color: '#ffd23f' },
  { key: '5', plan: [1, 5], name: '마스터', sub: 'MISSION 05', desc: '타깃 5개 · 거울 7개', color: '#ff7ab6' },
];
const cardRect = (i) => ({ x: MENU_X0 + i * (MENU_W + MENU_GAP), y: MENU_Y, w: MENU_W, h: MENU_H });
const LIVE_CHIP = { x: MENU_X0, y: 404, w: 330, h: 36 };
const inRect = (p, r) => p && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
/** 위치 → 메뉴 칸 (0~3 = 난이도 카드, 4 = LIVE 토글, -1 = 없음) */
function menuHit(p) {
  if (!p) return -1;
  for (let i = 0; i < MENU.length; i++) if (inRect(p, cardRect(i))) return i;
  return inRect(p, LIVE_CHIP) ? 4 : -1;
}
const handCursor = (h) => ({ x: Math.max(0, Math.min(1280, 640 + h.nx * 640 * 0.85)), y: Math.max(0, Math.min(720, 360 - h.ny * 360 * 0.85)) });
const LOST_BANNER_SEC = 1.2;
const LIVE_HOLD = 0.5;                     // 라이브 모드: 모든 타깃을 한 빔으로 이만큼 계속 맞히면 클리어
const DEFAULT_PLAN = [1, 4];               // 기본(Enter·손으로 시작): 튜토리얼 → MISSION 04. 3·5 키로 다른 난이도
const LIVE_MISSION_OFFSET = 10;            // 라이브 기록은 mission 번호 +10 (순위표를 발사 모드와 분리)
const NAME_WORDS = [['반짝이는', '번쩍이는', '똑똑한', '용감한', '날쌘', '빛나는', '재빠른'], ['거울', '레이저', '프리즘', '별빛', '광선', '탐험가']];

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const ctx = canvas.getContext('2d');
const sfx = new Sfx();

const G = {
  state: 'title', t: 0, clock: 0, plan: DEFAULT_PLAN, planIdx: 0, live: false,
  handHold: 0, needClear: false, liveSel: false, hover: -1, mouseHover: -1, cursor: null, dwell: 0, dwellOn: -1, board: [], boardDate: '', demo: null, lostT: 0, cardIdle: 0, camOn: false, server: { ok: null },
};
let R = null;                              // 지금 하는 미션
const clock = () => G.clock;
const input = new LaserInput({ useHand: !NO_HAND && !BROWSER_HAND, clock, onFire: (f) => fireNow(f) });
input.bind(canvas);
let webhand = null;
G.cam = { state: BROWSER_HAND ? 'loading' : 'idle', msg: BROWSER_HAND ? '카메라 준비 중…' : '' };
if (BROWSER_HAND) {
  webhand = new WebHand({ onData: (s) => input.onData(s), onStatus: (st) => { G.cam = st; } });
  // 브라우저 카메라가 안 되면(권한·카메라 없음·http 주소) 파이썬 서버의 손 인식(/hand)을 시도 — 젯슨·오르벡 구성
  webhand.start().then(() => { if (!G.camOn) G.camOn = webhand.togglePreview(); })      // 손 인식 화면은 기본으로 켜 둠 (V 로 끄기)
    .catch(() => { try { input._connect(); } catch { /* 마우스·키보드로 진행 */ } });
}

// ───────────────────────── 기록(이벤트 로그) ─────────────────────────
function log(type, data = {}) {
  if (!R) return;
  R.events.push({ t: Math.round((G.clock - R.startClock) * 1000), type, ...data });
}
const handAngles = (scene) => Object.fromEntries(scene.mirrors.filter((m) => m.kind === 'hand').map((m) => [m.id, norm180(m.angle)]));

// ───────────────────────── 한 발의 진행 (데모·실제 공용) ─────────────────────────
function makeFire(scene, progress) {
  const tr = trace(scene), ev = evaluate(tr, progress);
  const cum = [0];
  tr.segments.forEach((s) => cum.push(cum[cum.length - 1] + Math.hypot(s.x2 - s.x1, s.y2 - s.y1)));
  const events = ev.events.map((e) => ({ ...e, dist: cum[e.seg] + Math.hypot(e.x - tr.segments[e.seg].x1, e.y - tr.segments[e.seg].y1) }));
  const bounces = [];
  tr.segments.forEach((s, i) => { if (s.mirrorId) bounces.push({ dist: cum[i + 1], x: s.x2, y: s.y2 }); });
  return { tr, events, bounces, total: cum[cum.length - 1], dist: 0, ei: 0, bi: 0, hold: 0 };
}
/** 레이저를 dt만큼 진행. 지나간 반사·타깃은 콜백으로 알림. 다 끝나고 머문 뒤 true */
function advanceFire(f, dt, cb) {
  f.dist = Math.min(f.total, f.dist + BEAM_SPEED * dt);
  while (f.bi < f.bounces.length && f.bounces[f.bi].dist <= f.dist) { cb.bounce(f.bounces[f.bi], f.bi); f.bi++; }
  while (f.ei < f.events.length && f.events[f.ei].dist <= f.dist) { cb.event(f.events[f.ei]); f.ei++; }
  if (f.dist >= f.total) f.hold += dt;
  return f.dist >= f.total && f.hold >= SHOT_HOLD;
}

// ───────────────────────── 입자 · 효과 ─────────────────────────
function burst(list, x, y, color, n = 26, speed = 260) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random() * 0.8);
    list.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.5 + Math.random() * 0.4, max: 0.9, color, size: 2 + Math.random() * 4 });
  }
}
function stepParticles(list, dt) {
  for (const p of list) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96; p.life -= dt; }
  for (let i = list.length - 1; i >= 0; i--) if (list[i].life <= 0) list.splice(i, 1);
}

// ───────────────────────── 대기 화면 데모 (스스로 풀어 보임) ─────────────────────────
function resetDemo() {
  const lv = LEVELS[2];
  G.demo = { lv, scene: cloneScene(lv.scene), t: 0, progress: 0, fire: null, particles: [], flash: {}, fade: null };
}
function updateDemo(dt) {
  const d = G.demo;
  d.t += dt;
  const k = Math.min(1, d.t / 2.2), e = k * k * (3 - 2 * k);
  for (const m of d.scene.mirrors) {
    if (m.kind !== 'hand') continue;
    const from = d.lv.scene.mirrors.find((x) => x.id === m.id).angle, to = d.lv.solution[m.id];
    m.angle = from + lineDiff(to, from) * e;
  }
  if (d.t >= 3.0 && !d.fire && d.progress === 0 && !d.fade) d.fire = makeFire(d.scene, 0);
  if (d.fire) {
    const done = advanceFire(d.fire, dt, {
      bounce: (b) => burst(d.particles, b.x, b.y, '#ffffff', 6, 120),
      event: (ev) => { if (ev.type === 'TARGET_HIT') { d.progress = Math.max(d.progress, ev.order + 1); d.flash[ev.id] = 1; burst(d.particles, ev.x, ev.y, COLORS[d.scene.targets.find((t) => t.id === ev.id).color]); } },
    });
    if (done) { d.fade = { tr: d.fire.tr, age: 0 }; d.fire = null; }
  }
  if (d.fade) d.fade.age += dt;
  for (const id in d.flash) d.flash[id] = Math.max(0, d.flash[id] - dt * 2);
  stepParticles(d.particles, dt);
  if (d.t > 10.5) resetDemo();
}

// ───────────────────────── 미션 흐름 ─────────────────────────
function newRun(level) {
  const scene = cloneScene(level.scene);
  input.setLevel(scene);
  R = {
    level, scene, progress: 0, shotsUsed: 0, timeLeft: level.timeLimit, startClock: G.clock, events: [], fire: null,
    lastTrace: null, particles: [], flash: {}, wrong: {}, msg: null, score: 0, stars: 0, cleared: false, ended: false, endReason: '',
    lastShotAngles: null, tr: trace(scene), tutT: 0, logged: {}, loggedT: {}, wasTracked: {}, usedHand: false, diag: null, diagText: '',
    breakdown: null, badge: '', playId: null, qualifies: false, rank: null, posted: false, savedName: false, celebStars: 0,
    live: G.live, liveProgress: 0, bestProgress: 0, liveHold: 0, wrongHold: 0,
  };
  log('MISSION_START', { mission: level.id, name: level.name, mode: G.live ? 'live' : 'shot' });
  syncMirrors();
}

function start(plan = DEFAULT_PLAN, opts = {}) {
  G.plan = plan; G.planIdx = 0; G.handHold = 0; G.live = !!opts.live;
  beginMission(plan[0]);
}

function beginMission(id) {
  const lv = levelById(id);
  newRun(lv);
  G.state = lv.tutorial ? 'tutorial' : 'brief';
  G.t = 0; G.briefTick = 0;
  hideCard();
  $('r-name').value = '';
}

function toTitle() {
  G.state = 'title'; G.t = 0; G.handHold = 0; R = null; G.dwell = 0; G.dwellOn = -1;
  G.needClear = input.handsVisible > 0;        // 이전 사람이 아직 손을 들고 있으면, 손이 카드 밖으로 나간 뒤에 선택 (저절로 다시 시작되는 것 방지)
  hideCard(); resetDemo(); refreshBoard();
}

function syncMirrors() {
  if (!R || R.fire || R.ended) return;
  for (const m of R.scene.mirrors) if (m.kind === 'hand') m.angle = input.slots[m.id].angle;
}

function fireNow(info) {
  if (!R || R.live || !(G.state === 'play' || G.state === 'tutorial') || R.fire || R.ended) return;   // 라이브 모드는 발사가 없음
  const lv = R.level;
  if (lv.maxShots - R.shotsUsed <= 0) return;
  if (G.state === 'play' && R.timeLeft <= 0) return;
  syncMirrors();
  R.shotsUsed++;
  const f = makeFire(R.scene, R.progress);
  f.shot = R.shotsUsed; f.angles = handAngles(R.scene);
  R.fire = f; R.lastShotAngles = f.angles; R.lastTrace = null;
  sfx.fire();
  log('SHOT_FIRED', { shot: f.shot, via: info && info.via, angles: f.angles, path: [[f.tr.segments[0].x1, f.tr.segments[0].y1], ...f.tr.segments.map((s) => [Math.round(s.x2), Math.round(s.y2)])].map((p) => p.map(Math.round)) });
}

const fireCallbacks = {
  bounce: (b, i) => { sfx.bounce(i); burst(R.particles, b.x, b.y, '#ffffff', 8, 140); },
  event: (e) => {
    const tg = R.scene.targets.find((t) => t.id === e.id);
    if (e.type === 'TARGET_HIT') {
      R.progress = Math.max(R.progress, e.order + 1);
      R.flash[e.id] = 1; sfx.hit(e.order); burst(R.particles, e.x, e.y, COLORS[tg.color], 34, 300);
      log('TARGET_HIT', { shot: R.fire.shot, id: e.id, order: e.order, x: Math.round(e.x), y: Math.round(e.y) });
    } else {
      R.wrong[e.id] = 1; sfx.wrong();
      R.msg = { text: `순서가 달라요! ${R.level.targetsText || '표시된 번호 순서'}로 맞혀야 해요`, t: 2.6 };
      log('TARGET_WRONG_ORDER', { shot: R.fire.shot, id: e.id, expected: e.expected });
    }
  },
};

function finishShot() {
  const f = R.fire, lv = R.level, total = R.scene.targets.length;
  R.lastTrace = { tr: f.tr, age: 0 };
  if (f.tr.endReason === 'blocked') log('RAY_BLOCKED', { shot: f.shot, obstacle: f.tr.blockedBy, segments: f.tr.segments.length });
  const hitAny = f.events.some((e) => e.type === 'TARGET_HIT');
  if (!hitAny) sfx.miss();
  R.fire = null;
  if (R.progress >= total) endMission(true, 'clear');
  else if (lv.maxShots - R.shotsUsed <= 0) endMission(false, 'shots');
  else if (G.state === 'play' && R.timeLeft <= 0) endMission(false, 'time');
}

function endMission(success, reason) {
  const lv = R.level, total = R.scene.targets.length;
  R.ended = true; R.cleared = success; R.endReason = reason;
  if (R.live) R.progress = Math.max(R.progress, R.bestProgress);   // 라이브: 점수는 한 빔으로 가장 많이 맞힌 개수
  const shotsLeft = lv.maxShots - R.shotsUsed;
  if (!lv.tutorial) {
    const base = R.progress * 1000;
    const timeBonus = success ? Math.round(R.timeLeft) * 10 : 0;
    const shotBonus = success && !R.live ? Math.max(0, shotsLeft) * 150 : 0;
    R.score = base + timeBonus + shotBonus;
    R.breakdown = { base, timeBonus, shotBonus };
    if (success && R.live) {
      R.stars = 1 + (R.timeLeft >= 15 ? 1 : 0) + (R.timeLeft >= 28 ? 1 : 0);     // 45초 중 30초 안에 ★★, 17초 안에 ★★★
    } else if (success) {
      R.stars = 1 + (R.shotsUsed <= 3 ? 1 : 0) + (R.shotsUsed <= 2 && R.timeLeft >= 15 ? 1 : 0);
      if (R.shotsUsed === 1) R.badge = 'ONE SHOT';
    }
  }
  log('MISSION_END', { success, reason, mode: R.live ? 'live' : 'shot', targets: R.progress, total, score: R.score, shots: R.shotsUsed, timeLeft: Math.round(R.timeLeft * 10) / 10, stars: R.stars });
  G.t = 0;
  if (lv.tutorial) { G.state = 'tutorial_clear'; sfx.win(); return; }
  if (success) { G.state = 'celebrate'; sfx.win(); return; }
  const ang = handAngles(R.scene);        // 지금 거울 배치 (마지막 발사 뒤에는 거울이 안 움직이고, 시간 초과면 조준하던 배치)
  R.diag = diagnose(lv, withAngles(lv.scene, ang), R.live ? 0 : R.progress);   // 라이브는 한 빔으로 다 맞혀야 하니 처음부터 계산
  R.diagText = diagnosisText(R.diag);
  R.reviewScene = withAngles(lv.scene, ang);
  G.state = 'review'; sfx.lose();
}

function timeoutOrContinue(dt) {
  // 한 판의 시간 흐름 (play)
  if (R.ended) return;
  R.timeLeft = Math.max(0, R.timeLeft - dt);
  if (R.timeLeft <= 0 && !R.fire) endMission(false, 'time');
}

// ───────────────────────── 서버 ─────────────────────────
async function api(path, opts) {
  try {
    const r = await fetch(path, opts);
    G.server.ok = r.ok;
    if (!r.ok) return null;
    return await r.json();
  } catch { G.server.ok = false; return null; }
}
async function refreshBoard(mission = DEFAULT_PLAN[DEFAULT_PLAN.length - 1]) {
  const d = await api(`/api/laser/leaderboard?mission=${mission}`);
  if (d) { G.board = d.top || []; G.boardDate = d.date || ''; }
}
async function postPlay() {
  if (R.posted || R.level.tutorial) return;
  R.posted = true;
  const body = {
    mission: R.level.id + (R.live ? LIVE_MISSION_OFFSET : 0), score: R.score, targets: R.progress, total_targets: R.scene.targets.length, shots: R.shotsUsed,
    time_left: R.timeLeft, stars: R.stars, cleared: R.cleared, input_source: R.usedHand ? 'hand' : 'mouse', events: R.events,
  };
  const d = await api('/api/laser/plays', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (d && R) { R.playId = d.id; R.qualifies = !!d.qualifies; R.rank = d.rank; if (G.state === 'card') showCard(); }
  await refreshBoard(R ? R.level.id + (R.live ? LIVE_MISSION_OFFSET : 0) : 3);
  if (G.state === 'card' && R) showCard();
}
async function saveName() {
  if (!R || !R.playId || R.savedName) return;
  const el = $('r-name');
  const name = (el.value || '').trim().slice(0, 10);
  if (!name) return;
  R.savedName = true;
  const d = await api(`/api/laser/plays/${R.playId}/name`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player_name: name }) });
  if (d) { G.board = d.top || G.board; R.rank = d.rank; }
  if (G.state === 'card') showCard();
}
const makeName = () => `${NAME_WORDS[0][Math.floor(Math.random() * NAME_WORDS[0].length)]} ${NAME_WORDS[1][Math.floor(Math.random() * NAME_WORDS[1].length)]}`.slice(0, 10);

// ───────────────────────── 결과 카드 (DOM) ─────────────────────────
function hideCard() { $('result').classList.add('hidden'); }
function enterCard() {
  G.state = 'card'; G.t = 0; G.cardIdle = 0;
  postPlay();
  showCard();
}
function showCard() {
  const lv = R.level, el = $('result');
  el.classList.remove('hidden');
  $('r-title').textContent = `${lv.name} · ${lv.title}${R.live ? ' · LIVE' : ''}`;
  $('r-badge').textContent = R.cleared ? (R.badge ? '★ ONE SHOT 클리어! ★' : 'MISSION CLEAR') : (R.endReason === 'time' ? 'TIME UP' : '발사 횟수 소진');
  $('r-badge').className = R.cleared ? 'ok' : 'fail';
  $('r-stars').textContent = '★'.repeat(R.stars) + '☆'.repeat(3 - R.stars);
  $('r-score').textContent = R.score.toLocaleString('ko-KR');
  const b = R.breakdown || { base: 0, timeBonus: 0, shotBonus: 0 };
  $('r-detail').textContent = R.live
    ? `타깃 ${R.progress}/${R.scene.targets.length} · 남은 시간 ${Math.round(R.timeLeft)}초` + (R.cleared ? ` (타깃 ${b.base} + 시간 ${b.timeBonus})` : '')
    : `타깃 ${R.progress}/${R.scene.targets.length} · 발사 ${R.shotsUsed}번 · 남은 시간 ${Math.round(R.timeLeft)}초` +
      (R.cleared ? ` (타깃 ${b.base} + 시간 ${b.timeBonus} + 발사 ${b.shotBonus})` : '');
  $('r-diag').textContent = R.cleared ? '' : `💡 ${R.diagText}`;
  const nameRow = $('r-name-row');
  const showName = R.qualifies && !R.savedName;
  nameRow.classList.toggle('hidden', !showName);
  if (showName && !$('r-name').value) { $('r-name').value = makeName(); }
  $('r-rank').textContent = R.qualifies && R.rank ? `오늘 ${R.rank}위!` : '';
  const lb = $('r-lb');
  lb.innerHTML = '';
  (G.board || []).forEach((r, i) => {
    const li = document.createElement('li');
    if (R.playId && r.id === R.playId) li.className = 'me';
    li.innerHTML = `<b>${i + 1}</b><span class="nm"></span><span class="st">${'★'.repeat(r.stars)}</span><span class="sc">${r.score.toLocaleString('ko-KR')}</span>`;
    li.querySelector('.nm').textContent = r.player_name;
    lb.appendChild(li);
  });
  if (!(G.board || []).length) lb.innerHTML = '<li class="empty">아직 기록이 없어요. 첫 챔피언이 되어 보세요!</li>';
  $('r-hint').textContent = showName ? '이름을 확인하고 Enter — 저장 후 처음 화면으로' : '손을 내리거나 Enter를 누르면 처음 화면으로';
  if (showName) setTimeout(() => $('r-name').focus(), 50);
}

// ───────────────────────── 매 프레임 ─────────────────────────
function updateMissionCommon(dt) {
  syncMirrors();
  input.update();
  // 이벤트 로그: 거울 선택(손이 처음 잡힘), 각도 변화(0.4초마다, 3° 이상)
  for (const id of input.ids) {
    const sl = input.slots[id];
    if (sl.tracked && !R.wasTracked[id]) { log('MIRROR_SELECTED', { id, via: 'hand' }); R.usedHand = true; }
    R.wasTracked[id] = sl.tracked;
    const last = R.logged[id];
    if (last === undefined || (sl.angle !== last && G.clock - (R.loggedT[id] ?? -9) >= 0.4)) {
      if (last !== undefined) log('ANGLE_CHANGED', { id, angle: sl.angle });
      R.logged[id] = sl.angle; R.loggedT[id] = G.clock;
    }
  }
  if (!R.fire && !R.ended) R.tr = trace(R.scene);
  for (const id in R.flash) R.flash[id] = Math.max(0, R.flash[id] - dt * 2);
  for (const id in R.wrong) R.wrong[id] = Math.max(0, R.wrong[id] - dt * 1.5);
  if (R.msg) { R.msg.t -= dt; if (R.msg.t <= 0) R.msg = null; }
  if (R.lastTrace) { R.lastTrace.age += dt; if (R.lastTrace.age > 1.4) R.lastTrace = null; }
  stepParticles(R.particles, dt);
  // 손 놓침 안내
  const lostNow = input.available && !input.anyTracked;
  G.lostT = lostNow ? G.lostT + dt : 0;
}

function updateFire(dt) {
  if (R.fire && advanceFire(R.fire, dt, fireCallbacks)) finishShot();
}

/** 라이브 모드: 레이저가 항상 켜져 있어서, 지금 빔이 타깃을 순서대로 지나가는지 매 프레임 확인.
 *  세 타깃을 한 빔으로 LIVE_HOLD초 동안 계속 맞히면 클리어. */
function updateLive(dt) {
  if (!R.live || R.ended) return;
  const total = R.scene.targets.length;
  const ev = evaluate(R.tr, 0);
  const prev = R.liveProgress;
  R.liveProgress = ev.progress; R.progress = ev.progress;
  R.bestProgress = Math.max(R.bestProgress, ev.progress);
  for (let o = prev; o < ev.progress; o++) {            // 새로 맞힌 타깃: 소리·효과·기록
    const tg = R.scene.targets.find((t) => t.order === o);
    R.flash[tg.id] = 1; sfx.hit(o); burst(R.particles, tg.x, tg.y, COLORS[tg.color], 30, 280);
    log('TARGET_HIT', { live: true, id: tg.id, order: o });
  }
  const wrong = ev.events.filter((e) => e.type === 'TARGET_WRONG_ORDER');
  R.wrongHold = wrong.length ? R.wrongHold + dt : 0;
  for (const e of wrong) R.wrong[e.id] = Math.max(R.wrong[e.id] || 0, 0.6);
  if (R.wrongHold > 1.2 && !R.msg) {                    // 훑고 지나가는 건 말없이, 오래 그러고 있으면 알려 줌
    R.msg = { text: `순서가 달라요! ${R.level.targetsText || '표시된 번호 순서'}로 지나가야 해요`, t: 2.4 };
    log('TARGET_WRONG_ORDER', { live: true, id: wrong[0].id, expected: wrong[0].expected });
    R.wrongHold = 0;
  }
  R.liveHold = ev.progress >= total ? R.liveHold + dt : 0;
  if (R.liveHold >= LIVE_HOLD) endMission(true, 'clear');
}

/** 처음 화면: 손 커서가 카드 위에 HAND_START_SEC 동안 머물면 선택. LIVE 칩은 토글 */
function updateMenu(dt) {
  const hs = input.info && Array.isArray(input.info.hands) && input.available ? input.info.hands : [];
  G.cursor = hs.length ? handCursor(hs[0]) : null;
  G.hover = menuHit(G.cursor);
  if (G.needClear && G.hover < 0) G.needClear = false;
  if (G.hover >= 0 && !G.needClear) {
    G.dwell = G.hover === G.dwellOn ? G.dwell + dt : 0;
    G.dwellOn = G.hover;
    if (G.dwell >= HAND_START_SEC) {
      G.dwell = 0;
      if (G.hover === 4) { G.liveSel = !G.liveSel; G.needClear = true; sfx.tick(); }       // 토글 뒤에는 손이 칩 밖으로 나가야 다시 눌림
      else start(MENU[G.hover].plan, { live: G.liveSel });
    }
  } else { G.dwell = 0; G.dwellOn = -1; }
}

/** 상태별 배경음악: 대기·튜토리얼·카운트다운 = 잔잔, 본 게임 = 비트, 결과 화면 = 끔(효과음이 잘 들리게) */
const BGM_BY_STATE = { title: 'calm', tutorial: 'calm', tutorial_clear: 'calm', brief: 'calm', play: 'play', celebrate: 'off', review: 'off', card: 'calm' };

function step(dt, draw = true) {
  G.clock += dt; G.t += dt;
  sfx.setBgm(BGM_BY_STATE[G.state] || 'off');
  switch (G.state) {
    case 'title': {
      input.update();
      if (!G.demo) resetDemo();
      updateDemo(dt);
      updateMenu(dt);
      break;
    }
    case 'tutorial': {
      updateMissionCommon(dt);
      R.tutT += dt;
      updateLive(dt);
      updateFire(dt);
      if (!R.ended && R.tutT > TUTORIAL_MAX_SEC) { R.msg = { text: '튜토리얼을 건너뛰고 본 미션으로 갑니다', t: 2 }; endMission(true, 'skip'); }
      break;
    }
    case 'tutorial_clear': {
      updateMissionCommon(dt);
      if (G.t >= CLEAR_SEC) { G.planIdx++; beginMission(G.plan[G.planIdx] ?? DEFAULT_PLAN[DEFAULT_PLAN.length - 1]); }
      break;
    }
    case 'brief': {
      updateMissionCommon(dt);
      const sec = Math.floor(G.t), prev = G.briefTick;
      if (sec > prev && sec >= 1 && sec <= 3) { sfx.tick(); }
      G.briefTick = sec;
      if (G.t >= BRIEF_SEC) { G.state = 'play'; G.t = 0; sfx.go(); log('PLAY_START'); }
      break;
    }
    case 'play': {
      updateMissionCommon(dt);
      updateLive(dt);
      timeoutOrContinue(dt);
      updateFire(dt);
      if (G.state === 'play' && !R.ended && R.timeLeft <= 0 && !R.fire) endMission(false, 'time');
      break;
    }
    case 'celebrate': {
      updateMissionCommon(dt);
      const want = Math.min(R.stars, Math.floor(G.t / 0.5));
      while (R.celebStars < want) { R.celebStars++; sfx.star(); }
      if (G.t >= CELEBRATE_SEC) enterCard();
      break;
    }
    case 'review': {
      updateMissionCommon(dt);
      if (G.t >= REVIEW_SEC) enterCard();
      break;
    }
    case 'card': {
      input.update();
      G.cardIdle += dt;
      if (R) {
        const showName = R.qualifies && !R.savedName;
        if (showName && G.cardIdle > CARD_IDLE_SEC - 7) saveName();          // 이름을 안 바꿔도 미리 채운 이름으로 저장
        if (G.cardIdle > CARD_IDLE_SEC && (!showName)) toTitle();
      }
      break;
    }
    default: break;
  }
  if (draw) render();
}

// ───────────────────────── 그리기 ─────────────────────────
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr);
  canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
}
window.addEventListener('resize', resize);
resize();

function fmtTime(s) { return s <= 10 ? s.toFixed(1) : String(Math.ceil(s)); }

function drawArena(scene, st) {
  // st: {progress, flash, wrong, t, tracked(id)->bool, active, preview:{segments}, ghost}
  drawObstacles(ctx, scene.obstacles);
  drawEmitter(ctx, scene.emitter, st.t);
  for (const m of scene.mirrors) {
    const label = m.id === 'H1' ? '왼손' : m.id === 'H2' ? '오른손' : '';
    drawMirror(ctx, m, { label, tracked: st.tracked ? st.tracked(m.id) : false, active: st.active === m.id && st.showActive, t: st.t });
  }
  scene.targets.forEach((tg) => drawTarget(ctx, tg, {
    activated: tg.order < st.progress, isNext: tg.order === st.progress, t: st.t,
    showNumber: scene.targets.length > 1, flash: st.flash ? st.flash[tg.id] || 0 : 0, wrong: st.wrong ? st.wrong[tg.id] || 0 : 0,
  }));
}

function renderTitle() {
  const d = G.demo || (resetDemo(), G.demo);
  const sc = d.scene;
  ctx.globalAlpha = 0.9;
  if (d.fade) drawPath(ctx, d.fade.tr.segments, { alpha: Math.max(0, 1 - d.fade.age / 1.6) * 0.6 });
  drawArena(sc, { progress: d.progress, flash: d.flash, t: G.clock, tracked: () => false });
  if (!d.fire && !d.fade && d.t < 3.0) drawPath(ctx, trace(sc).segments.slice(0, 2), { dash: [14, 12], width: 4, alpha: 0.5, core: false });
  if (d.fire) drawPath(ctx, d.fire.tr.segments, { upTo: d.fire.dist, width: 8 });
  drawParticles(ctx, d.particles);
  ctx.globalAlpha = 1;
  // 제목 (위쪽 띠: 타깃·거울을 가리지 않게 낮게)
  panel(ctx, 240, 6, 800, 94, { fill: 'rgba(5,9,20,0.8)' });
  txt(ctx, 'LASER CHALLENGE', W / 2, 40, { size: 54, color: '#ffffff', glow: CYAN, weight: '900' });
  txt(ctx, '내 손이 거울이 된다 — 레이저를 순서대로 맞혀라!', W / 2, 80, { size: 22, color: CYAN });
  // 난이도 카드
  const pulse = 0.6 + Math.sin(G.clock * 4) * 0.4;
  const hand = input.available;
  const hov = G.hover >= 0 ? G.hover : G.mouseHover;
  const chip = LIVE_CHIP;
  ctx.save(); const bg = ctx.createLinearGradient(0, 392, 0, 590); bg.addColorStop(0, 'rgba(5,9,20,0)'); bg.addColorStop(0.18, 'rgba(5,9,20,0.88)'); bg.addColorStop(1, 'rgba(5,9,20,0.88)'); ctx.fillStyle = bg; ctx.fillRect(130, 392, 1020, 198); ctx.restore();   // 데모가 카드와 겹쳐 보이지 않게
  panel(ctx, chip.x, chip.y, chip.w, chip.h, { fill: G.liveSel ? 'rgba(255,90,120,0.3)' : 'rgba(5,9,20,0.8)', stroke: hov === 4 ? '#ffffff' : G.liveSel ? '#ff5a78' : 'rgba(76,240,255,0.35)', r: 18 });
  txt(ctx, G.liveSel ? '● LIVE 모드 켜짐 (L)' : '○ LIVE 모드 꺼짐 (L) — 빔이 항상 켜진 상태로 도전', chip.x + chip.w / 2, chip.y + chip.h / 2, { size: 16, color: G.liveSel ? '#ffb3c0' : '#9fb4d8', weight: '600' });
  MENU.forEach((m, i) => {
    const r = cardRect(i), on = hov === i;
    panel(ctx, r.x, r.y, r.w, r.h, { fill: on ? 'rgba(20,34,66,0.95)' : 'rgba(5,9,20,0.85)', stroke: on ? m.color : 'rgba(76,240,255,0.3)', r: 18 });
    txt(ctx, m.name, r.x + r.w / 2, r.y + 36, { size: 36, color: m.color, glow: on ? m.color : null });
    txt(ctx, m.desc, r.x + r.w / 2, r.y + 72, { size: 18, color: '#e8f6ff', weight: '600' });
    txt(ctx, `${m.sub}  ·  키 ${m.key}`, r.x + r.w / 2, r.y + 98, { size: 14, color: '#7f93b8', weight: '500' });
    if (G.hover === i && G.dwell > 0) {                          // 손으로 고르는 중: 아래쪽 진행 막대
      ctx.save(); ctx.fillStyle = m.color; ctx.fillRect(r.x + 14, r.y + r.h - 9, (r.w - 28) * Math.min(1, G.dwell / HAND_START_SEC), 5); ctx.restore();
    }
  });
  panel(ctx, 330, 596, 620, 88, { fill: 'rgba(5,9,20,0.85)', stroke: `rgba(93,255,157,${0.3 + pulse * 0.5})` });
  txt(ctx, hand ? '✋ 손으로 난이도 카드를 1초 동안 가리키세요' : '난이도를 클릭하거나 2·3·4·5 키 (Enter = 추천)', W / 2, 628, { size: hand ? 30 : 28, color: '#5dff9d', alpha: 0.6 + pulse * 0.4 });
  txt(ctx, hand ? '시작하면: 손가락 방향 = 거울 방향 · 주먹 = 발사 · 손을 내려도 각도는 유지' : '(손 인식이 꺼져 있어요: 마우스 휠·←→ 로 각도, 클릭·Space 로 발사)', W / 2, 664, { size: 19, color: '#9fb4d8', weight: '500' });
  if (!sfx.running && !sfx.muted) txt(ctx, '🔇 소리가 안 나요 — 화면을 한 번 클릭하거나 아무 키나 누르세요', W - 24, 704, { size: 17, align: 'right', color: '#ffd23f', weight: '600', alpha: 0.6 + pulse * 0.4 });
  if (sfx.muted) txt(ctx, '🔇 음소거 (M 키로 켜기)', W - 24, 704, { size: 17, align: 'right', color: '#9fb4d8', weight: '500' });
  if (G.cursor) {                                              // 손 커서
    ctx.save(); ctx.strokeStyle = '#5dff9d'; ctx.lineWidth = 4; ctx.shadowColor = '#5dff9d'; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(G.cursor.x, G.cursor.y, 20, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(93,255,157,0.35)'; ctx.beginPath(); ctx.arc(G.cursor.x, G.cursor.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  // 카메라 상태 (왼쪽 아래 작게): 준비 중 / 연결됨 / 오류 이유
  if (BROWSER_HAND && G.cam) {
    const cs = G.cam, ok = cs.state === 'ok', viaServer = cs.state === 'error' && input.available;   // 브라우저 카메라가 안 돼도 서버 손 인식이 되면 그걸로
    const label = viaServer ? `📷 서버 카메라로 연결됨 · 손 ${input.handsVisible}개` : ok ? `📷 카메라 연결됨 · 손 ${input.handsVisible}개${cs.fps ? ` · ${cs.fps}fps` : ''}   (V: 손 인식 화면 켜기/끄기)` : `📷 ${cs.msg || '카메라 준비 중…'}${cs.state === 'error' ? '  → 마우스·키보드로 할 수 있어요' : ''}`;
    txt(ctx, label, 316, 704, { size: 17, align: 'left', color: ok || viaServer ? '#5dff9d' : cs.state === 'error' ? '#ff9bb0' : '#9fb4d8', weight: '500' });
  }
  // 오늘의 챔피언 (오른쪽 빈 공간)
  panel(ctx, 1010, 130, 256, 290, { fill: 'rgba(5,9,20,0.8)' });
  txt(ctx, '🏆 오늘의 챔피언', 1138, 160, { size: 22, color: '#ffd23f' });
  if (!G.board.length) txt(ctx, '첫 챔피언이 되어 보세요!', 1138, 280, { size: 19, color: '#9fb4d8', weight: '500' });
  G.board.slice(0, 5).forEach((r, i) => {
    const y = 204 + i * 44;
    txt(ctx, String(i + 1), 1032, y, { size: 21, color: i === 0 ? '#ffd23f' : '#9fb4d8' });
    txt(ctx, r.player_name, 1060, y, { size: 21, align: 'left' });
    txt(ctx, r.score.toLocaleString('ko-KR'), 1250, y, { size: 21, align: 'right', color: CYAN });
  });
}

function drawHud() {
  const lv = R.level;
  ctx.save();
  const g = ctx.createLinearGradient(0, 0, 0, 70); g.addColorStop(0, 'rgba(5,9,20,0.95)'); g.addColorStop(1, 'rgba(5,9,20,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, 70); ctx.restore();
  txt(ctx, `${lv.name}  ·  ${lv.title}`, 24, 30, { size: 24, align: 'left', color: CYAN });
  if (lv.tutorial) txt(ctx, 'TUTORIAL', W / 2, 32, { size: 30, color: '#5dff9d' });
  else {
    const low = R.timeLeft <= 10 && G.state === 'play';
    txt(ctx, fmtTime(R.timeLeft), W / 2, 34, { size: 46, color: low ? '#ff4d6d' : '#ffffff', glow: low ? '#ff4d6d' : CYAN, alpha: low ? 0.65 + Math.abs(Math.sin(G.clock * 6)) * 0.35 : 1 });
  }
  // 발사 횟수 (라이브 모드는 발사가 없어서 LIVE 표시)
  if (R.live) {
    txt(ctx, '● LIVE', W - 24, 30, { size: 24, align: 'right', color: '#ff4d6d', glow: '#ff4d6d', alpha: 0.7 + Math.abs(Math.sin(G.clock * 3)) * 0.3 });
    if (!lv.tutorial) txt(ctx, `${(R.progress * 1000).toLocaleString('ko-KR')}`, W - 24, 62, { size: 22, align: 'right', color: '#ffd23f' });
  } else if (lv.tutorial) txt(ctx, '발사 ∞', W - 24, 30, { size: 22, align: 'right', color: '#9fb4d8' });
  else {
    for (let i = 0; i < lv.maxShots; i++) {
      const x = W - 220 + i * 30, left = i >= R.shotsUsed;
      ctx.save(); ctx.fillStyle = left ? CYAN : 'transparent'; ctx.strokeStyle = CYAN; ctx.lineWidth = 3; ctx.shadowColor = CYAN; ctx.shadowBlur = left ? 12 : 0;
      ctx.beginPath(); ctx.arc(x, 30, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
    }
    txt(ctx, `${(R.progress * 1000).toLocaleString('ko-KR')}`, W - 24, 62, { size: 22, align: 'right', color: '#ffd23f' });
  }
}

function drawRunScene({ showPreview = true } = {}) {
  const lv = R.level, sc = R.scene;
  if (R.lastTrace) drawPath(ctx, R.lastTrace.tr.segments, { alpha: Math.max(0, 1 - R.lastTrace.age / 1.4) * 0.55, width: 6 });
  const singleHand = input.handActive && input.handsVisible === 1 && input.ids.length > 1 && !!input.lastFed;   // 한 손으로 두 거울을 번갈아 조종 중: 지금 조종 중인 거울 강조
  drawArena(sc, { progress: R.progress, flash: R.flash, wrong: R.wrong, t: G.clock, tracked: (id) => !!(input.slots[id] && input.slots[id].tracked), active: singleHand ? input.lastFed : input.active, showActive: singleHand || (!input.handActive && input.ids.length > 1) });
  const aiming = !R.fire && !R.ended;
  if (R.live && showPreview && (aiming || R.cleared)) {
    // 라이브: 레이저가 항상 켜져 있고, 각도를 바꾸면 경로가 바로 따라옴
    drawPath(ctx, R.tr.segments, { width: 8, glow: 24, alpha: 0.95 });
    if (lv.tutorial && aiming) drawPrinciple(ctx, R.tr, G.clock);
  } else if (showPreview && aiming) {
    const end = drawPath(ctx, R.tr.segments.slice(0, lv.previewSegs), { dash: [14, 12], width: 4, alpha: 0.6, core: false, glow: 10 });
    if (end) { ctx.save(); ctx.fillStyle = CYAN; ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.arc(end.x, end.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    if (lv.tutorial) drawPrinciple(ctx, R.tr, G.clock);
  }
  if (R.fire) {
    const head = drawPath(ctx, R.fire.tr.segments, { upTo: R.fire.dist, width: 9, glow: 26 });
    if (head && R.fire.dist < R.fire.total) { ctx.save(); ctx.fillStyle = '#fff'; ctx.shadowColor = CYAN; ctx.shadowBlur = 30; ctx.beginPath(); ctx.arc(head.x, head.y, 9, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
  }
  drawParticles(ctx, R.particles);
}

function caption(text, y = 648, color = '#e8f6ff') {
  ctx.save(); ctx.font = `700 26px ${R_.FONT}`; const w = Math.min(1180, ctx.measureText(text).width + 60); ctx.restore();
  panel(ctx, W / 2 - w / 2, y - 30, w, 60, { fill: 'rgba(5,9,20,0.88)' });
  txt(ctx, text, W / 2, y, { size: 26, color });
}

function drawControlHint() {
  const handMode = input.handActive || input.available;
  const y = 700;
  if (R.live) txt(ctx, handMode ? '손가락이 가리키는 방향 = 거울 방향   ·   레이저는 항상 켜져 있어요   ·   주먹 = 각도 고정' : '마우스 휠 · ← → : 각도   Tab : 거울 바꾸기   (레이저 상시 발사)', W / 2, y, { size: 18, color: '#7f93b8', weight: '500' });
  else if (handMode) txt(ctx, '손가락이 가리키는 방향 = 거울 방향   ·   주먹을 쥐면 발사', W / 2, y, { size: 18, color: '#7f93b8', weight: '500' });
  else txt(ctx, '마우스 휠 · ← → : 각도   Tab : 거울 바꾸기   Space · 클릭 : 발사', W / 2, y, { size: 18, color: '#7f93b8', weight: '500' });
}

function renderRun() {
  drawRunScene();
  drawHud();
  const lv = R.level;
  const playing = G.state === 'play' || G.state === 'tutorial';
  if (playing && G.lostT > LOST_BANNER_SEC) caption('✋ 손을 카메라에 보여주세요 (거울 각도는 그대로 유지돼요)', 110, '#ffd23f');
  if (R.msg) caption(R.msg.text, 600, '#ff9bb0');
  if (R.live && playing && !R.ended && R.liveHold > 0) {                     // 다 맞히는 중: 유지 게이지
    const k = Math.min(1, R.liveHold / LIVE_HOLD);
    ctx.save(); ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(W / 2 - 120, 72, 240, 8); ctx.fillStyle = '#5dff9d'; ctx.shadowColor = '#5dff9d'; ctx.shadowBlur = 12; ctx.fillRect(W / 2 - 120, 72, 240 * k, 8); ctx.restore();
    caption('✨ 그대로 유지!', 600, '#5dff9d');
  }
  if (G.state === 'tutorial' && R.live) {
    const aims = R.progress > 0;
    const hand = input.available;
    caption(aims ? '좋아요! 빔이 타깃에 닿았어요 — 그대로 잠깐!' : (hand ? '손가락 방향이 거울이에요. 레이저가 빨간 타깃에 닿게 손을 기울여 보세요' : '마우스 휠이나 ← → 로 거울을 돌려 레이저가 타깃에 닿게 해 보세요'), 636);
  } else if (G.state === 'tutorial' && !R.fire) {
    const aims = R.tr.hits && R.tr.hits.length > 0;
    const hand = input.available;
    let t1;
    if (R.shotsUsed === 0) t1 = aims ? (hand ? '좋아요! 이제 주먹을 꽉 쥐면 레이저 발사 ✊' : '좋아요! Space 또는 클릭으로 발사') : (hand ? '손가락 방향이 거울이에요. 점선 빔이 빨간 타깃을 향하게 손을 기울여 보세요' : '마우스 휠이나 ← → 로 거울을 돌려 점선이 타깃을 향하게 해 보세요');
    else t1 = '입사각 = 반사각 : 점선이 타깃을 지나가도록 각도를 다시 맞춰 보세요';
    caption(t1, 636);
  }
  if (playing) drawControlHint();
  if (G.state === 'brief') renderBrief();
  if (G.state === 'tutorial_clear') {
    ctx.save(); ctx.fillStyle = 'rgba(5,9,20,0.55)'; ctx.fillRect(0, 0, W, H); ctx.restore();
    txt(ctx, '반사의 원리를 익혔어요!', W / 2, H / 2 - 10, { size: 60, color: '#5dff9d', glow: '#5dff9d', weight: '900' });
    txt(ctx, '이제 진짜 미션이에요', W / 2, H / 2 + 56, { size: 30, color: '#e8f6ff' });
  }
  if (G.state === 'celebrate') renderCelebrate();
}

function renderBrief() {
  const lv = R.level, sec = Math.floor(G.t);
  ctx.save(); ctx.fillStyle = 'rgba(5,9,20,0.72)'; ctx.fillRect(0, 70, W, H - 70); ctx.restore();
  txt(ctx, lv.name, W / 2, 190, { size: 84, color: '#fff', glow: CYAN, weight: '900' });
  txt(ctx, lv.title, W / 2, 262, { size: 38, color: CYAN });
  const rules = [`제한시간 ${lv.timeLimit}초`, R.live ? '레이저 상시 ON · 한 줄기 빔으로!' : `발사 ${lv.maxShots}번`, lv.targetsText || '빨강 → 노랑 → 파랑 순서대로'];
  rules.forEach((r, i) => txt(ctx, r, W / 2, 335 + i * 44, { size: 28, color: '#e8f6ff', weight: '600' }));
  txt(ctx, input.available ? '손을 들어 거울을 준비하세요 ✋  (한 손으로 번갈아 맞춰도 돼요)' : '마우스·키보드로 준비하세요', W / 2, 490, { size: 26, color: '#5dff9d' });
  if (sec >= 1 && sec <= 3) {
    const n = 4 - sec, f = G.t - sec;
    txt(ctx, String(n), W / 2, 590, { size: 130 - f * 30, color: '#ffd23f', glow: '#ffd23f', weight: '900', alpha: 1 - f * 0.5 });
  }
}

function renderCelebrate() {
  ctx.save(); ctx.fillStyle = 'rgba(5,9,20,0.5)'; ctx.fillRect(0, 0, W, H); ctx.restore();
  const k = Math.min(1, G.t / 0.4);
  txt(ctx, R.badge ? 'ONE SHOT!' : 'MISSION CLEAR!', W / 2, 250, { size: 40 + k * 56, color: '#5dff9d', glow: '#5dff9d', weight: '900' });
  for (let i = 0; i < 3; i++) {
    const on = i < R.celebStars;
    txt(ctx, on ? '★' : '☆', W / 2 + (i - 1) * 120, 380, { size: on ? 110 : 90, color: on ? '#ffd23f' : '#44506e', glow: on ? '#ffd23f' : null });
  }
  txt(ctx, `${R.score.toLocaleString('ko-KR')}점`, W / 2, 500, { size: 64, color: '#fff', glow: CYAN, weight: '900' });
}

function renderReview() {
  const lv = R.level, gs = withAngles(lv.scene, lv.solution);
  // 내가 쏜 마지막 배치 + 정답 예시(점선)
  drawRunScene({ showPreview: false });
  const full = trace(gs);
  drawPath(ctx, full.segments, { color: '#ffd23f', width: 5, dash: [12, 10], alpha: 0.75, core: false, glow: 12 });
  for (const m of gs.mirrors) if (m.kind === 'hand') drawMirror(ctx, m, { ghost: true });
  drawHud();
  ctx.save(); const g = ctx.createLinearGradient(0, 560, 0, H); g.addColorStop(0, 'rgba(5,9,20,0)'); g.addColorStop(0.35, 'rgba(5,9,20,0.95)'); ctx.fillStyle = g; ctx.fillRect(0, 560, W, H - 560); ctx.restore();
  txt(ctx, R.endReason === 'time' ? '⏱ 시간이 다 됐어요' : '발사 횟수를 모두 썼어요', W / 2, 604, { size: 22, color: '#ff9bb0' });
  txt(ctx, `💡 ${R.diagText}`, W / 2, 646, { size: 30, color: '#ffd23f' });
  txt(ctx, '노란 점선 = 정답 예시 (왼손·오른손 거울 각도)', W / 2, 690, { size: 20, color: '#c9b46a', weight: '500' });
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  const s = Math.min(innerWidth / W, innerHeight / H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * s, 0, 0, dpr * s, (canvas.width - W * dpr * s) / 2, (canvas.height - H * dpr * s) / 2);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  drawBackground(ctx, G.clock);
  if (G.state === 'title') renderTitle();
  else if (G.state === 'review') renderReview();
  else if (R) { renderRun(); if (G.state === 'card') { ctx.fillStyle = 'rgba(5,9,20,0.6)'; ctx.fillRect(0, 0, W, H); } }
  ctx.restore();
}

// ───────────────────────── 운영자 키 · 기타 ─────────────────────────
function toggleCam() {
  if (webhand && webhand.running) { G.camOn = webhand.togglePreview(); return; }   // 브라우저 손 인식: 카메라 화면 + 관절 + 각도 미리보기
  G.camOn = !G.camOn;
  const img = $('cam');
  img.classList.toggle('hidden', !G.camOn);
  img.src = G.camOn ? '/video' : '';
}
window.addEventListener('keydown', (e) => {
  sfx.unlock();
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) {
    if (e.code === 'Enter' && e.target.id === 'r-name') { saveName(); e.preventDefault(); }
    return;
  }
  switch (e.code) {
    case 'Enter':
      if (G.state === 'title') start(DEFAULT_PLAN, { live: G.liveSel });
      else if (G.state === 'card') toTitle();
      else if (G.state === 'review') enterCard();
      break;
    case 'Digit2': if (G.state === 'title') start([1, 2], { live: G.liveSel }); break;       // 쉬운 모드: 튜토리얼 → MISSION 02
    case 'Digit3': if (G.state === 'title') start([1, 3], { live: G.liveSel }); break;       // 보통: MISSION 03 (타깃 3개)
    case 'Digit4': if (G.state === 'title') start([1, 4], { live: G.liveSel }); break;       // 기본: MISSION 04 (타깃 4개)
    case 'Digit5': if (G.state === 'title') start([1, 5], { live: G.liveSel }); break;       // 어려움: MISSION 05 (타깃 5개, 거울 7개)
    case 'KeyL': if (G.state === 'title') G.liveSel = !G.liveSel; break;   // 라이브 모드 켜기/끄기: 레이저 상시 ON, 한 줄기 빔으로 모든 타깃
    case 'KeyN':                                                         // 건너뛰기
      if (G.state === 'tutorial' && R && !R.ended) endMission(true, 'skip');
      else if (G.state === 'brief') G.t = BRIEF_SEC;
      break;
    case 'KeyR': if (R && ['tutorial', 'brief', 'play'].includes(G.state)) beginMission(R.level.id); break;
    case 'Escape': toTitle(); break;
    case 'KeyV': toggleCam(); break;
    case 'KeyM': sfx.setMuted(!sfx.muted); break;
    case 'KeyF': if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); break;
    default: break;
  }
});
const toLogical = (e) => { const s = Math.min(innerWidth / W, innerHeight / H); return { x: (e.clientX - (innerWidth - W * s) / 2) / s, y: (e.clientY - (innerHeight - H * s) / 2) / s }; };
// 소리: 브라우저는 클릭·키 입력 전에는 소리를 막으므로 첫 조작에서 켬 (손으로만 하면 안 켜질 수 있어서 처음 화면에 안내를 띄움)
['pointerdown', 'touchstart', 'click'].forEach((ev) => window.addEventListener(ev, () => sfx.unlock(), { passive: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden) sfx.unlock(); });
sfx.unlock();
canvas.addEventListener('pointermove', (e) => { G.mouseHover = G.state === 'title' ? menuHit(toLogical(e)) : -1; });
canvas.addEventListener('pointerdown', (e) => {
  sfx.unlock();
  if (G.state !== 'title') return;
  const hit = menuHit(toLogical(e));
  if (hit === 4) G.liveSel = !G.liveSel;
  else if (hit >= 0) start(MENU[hit].plan, { live: G.liveSel });
});
$('r-save').addEventListener('click', saveName);
$('result').addEventListener('click', (e) => { if (e.target.id === 'result') toTitle(); });
$('r-again').addEventListener('click', toTitle);

// 시작
resetDemo();
refreshBoard();
if (MANUAL) render();
else {
  let last = performance.now();
  const frame = (now) => { const dt = Math.min(0.1, (now - last) / 1000); last = now; step(dt); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
}
setInterval(() => { if (G.state === 'title') refreshBoard(); }, 30000);

// 테스트·디버그용
window.laser = {
  G, input, sfx, LEVELS, SNAP,
  get R() { return R; },
  step, start, toTitle, fireNow, saveName, enterCard, LIVE_HOLD,
  /** 처음 화면 메뉴 칸 i(0~3 카드, 4 LIVE 칩)의 한가운데를 가리키는 손 위치 (테스트용) */
  menuHand(i) { const r = i === 4 ? LIVE_CHIP : cardRect(i); return { nx: (r.x + r.w / 2 - 640) / 544, ny: (360 - (r.y + r.h / 2)) / 306 }; },
  advance(sec, dt = 1 / 30) { const n = Math.max(1, Math.round(sec / dt)); for (let i = 0; i < n; i++) step(dt, i === n - 1); },
  setAngles(a) { for (const [id, v] of Object.entries(a)) { input.slots[id].angle = v; input.slots[id].raw = v; } syncMirrors(); },
  hands(list) { input.onData({ available: true, visible: list.length > 0, hands: list }); },
  snapshot() { return { state: G.state, progress: R && R.progress, shots: R && R.shotsUsed, timeLeft: R && R.timeLeft, score: R && R.score, stars: R && R.stars, cleared: R && R.cleared, endReason: R && R.endReason }; },
};
