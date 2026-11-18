// 레이저 챌린지 단위 테스트 (광학 엔진 · 레벨 해 존재 · 풀이기). 실행: node tests/laser_unit.mjs
import { trace, evaluate, reflect, dirFromDeg, deg, lineDiff, mirrorEnds, MAX_REFLECT } from '../src/laser/optics.js';
import { LEVELS, SNAP, snapAngle } from '../src/laser/levels.js';
import { withAngles, clearsFrom, solveAngles, diagnose, diagnosisText, verifyLevel } from '../src/laser/solver.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const empty = (over = {}) => ({ W: 1280, H: 720, emitter: { x: 100, y: 400, angle: 0 }, mirrors: [], obstacles: [], targets: [], ...over });
const M = (id, x, y, angle, len = 150, kind = 'hand') => ({ id, kind, x, y, len, angle });

console.log('1. 반사 정확도');
{
  // 동쪽으로 가던 빛이 45° 거울을 만나면 위쪽(화면 위, y 감소)으로
  const t = trace(empty({ mirrors: [M('a', 400, 400, 45)] }));
  const s1 = t.segments[1];
  ok(t.segments.length >= 2 && near(s1.x2, 400, 1e-3) && s1.y2 < 400 && near(s1.y2, 0, 1e-3), '45° 거울: 동 → 북', JSON.stringify(s1));
  ok(near(t.segments[0].x2, 400, 1e-6) && near(t.segments[0].y2, 400, 1e-6), '거울 위에서 정확히 반사');
  // 무작위 거울 각도: 입사각 = 반사각 (법선 기준), 반사 후 방향 길이 1
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const a = Math.random() * 360, th = Math.random() * 180;
    const d = dirFromDeg(a), u = dirFromDeg(th), r = reflect(d, u);
    const n = { x: -u.y, y: u.x };
    const di = d.x * n.x + d.y * n.y, dr = r.x * n.x + r.y * n.y;       // 법선 성분은 부호만 반대
    const ti = d.x * u.x + d.y * u.y, tr = r.x * u.x + r.y * u.y;       // 접선 성분은 같음
    worst = Math.max(worst, Math.abs(di + dr), Math.abs(ti - tr), Math.abs(Math.hypot(r.x, r.y) - 1));
  }
  ok(worst < 1e-9, '무작위 400개: 입사각 = 반사각, 길이 보존', `worst=${worst}`);
  // 공식 r = d − 2(d·n)n 과 같은지
  const d = dirFromDeg(30), u = dirFromDeg(70), n = { x: -u.y, y: u.x }, k = 2 * (d.x * n.x + d.y * n.y);
  const r1 = reflect(d, u), r2 = { x: d.x - k * n.x, y: d.y - k * n.y };
  ok(near(r1.x, r2.x) && near(r1.y, r2.y), 'r = d − 2(d·n)n 와 일치');
}

console.log('2. 가장 가까운 충돌');
{
  const blocked = trace(empty({ mirrors: [M('a', 600, 400, 45)], obstacles: [{ x: 300, y: 300, w: 40, h: 200 }] }));
  ok(blocked.endReason === 'blocked' && blocked.segments.length === 1 && near(blocked.segments[0].x2, 300, 1e-6), '거울 앞 장애물이 먼저 막음');
  const mirrorFirst = trace(empty({ mirrors: [M('a', 300, 400, 45)], obstacles: [{ x: 600, y: 300, w: 40, h: 200 }] }));
  ok(mirrorFirst.segments[0].mirrorId === 'a' && mirrorFirst.segments.length >= 2, '장애물 앞 거울이 먼저 반사');
  const beyond = trace(empty({ mirrors: [M('a', 400, 600, 45, 100)] }));            // 빛은 y=400, 거울은 y 550~650
  ok(beyond.endReason === 'boundary' && beyond.segments.length === 1, '거울을 벗어난 빛은 그냥 지나감');
  const bound = trace(empty());
  ok(bound.endReason === 'boundary' && near(bound.segments[0].x2, 1280, 1e-6), '경계에서 끝남');
}

console.log('3. 자기 충돌 방지 · 반사 횟수 상한');
{
  // 마주 보는 평행 거울 사이에서 수직으로 튕김 → 무한 반복 방지
  const t = trace(empty({ emitter: { x: 640, y: 360, angle: 90 }, mirrors: [M('top', 640, 100, 0, 400), M('bot', 640, 620, 0, 400)] }));
  ok(t.endReason === 'max_reflect' && t.segments.length === MAX_REFLECT + 1, `반사 ${MAX_REFLECT}회에서 멈춤`, `${t.endReason} ${t.segments.length}`);
  // 같은 거울에 다시 맞지 않음: 45° 거울 한 장 → 선분 2개
  const one = trace(empty({ mirrors: [M('a', 400, 400, 45)] }));
  ok(one.segments.length === 2, '반사 직후 같은 거울에 다시 맞지 않음');
}

console.log('4. 타깃 순서');
{
  const sc = empty({ targets: [{ id: 'T1', order: 0, color: 'red', x: 300, y: 400, r: 30 }, { id: 'T2', order: 1, color: 'yellow', x: 600, y: 400, r: 30 }] });
  const t = trace(sc);
  ok(t.hits.length === 2 && t.hits[0].id === 'T1' && t.hits[1].id === 'T2', '경로 순서대로 hits');
  ok(evaluate(t, 0).progress === 2, '순서대로 지나가면 둘 다 활성화');
  const rev = empty({ targets: [{ id: 'T1', order: 0, color: 'red', x: 600, y: 400, r: 30 }, { id: 'T2', order: 1, color: 'yellow', x: 300, y: 400, r: 30 }] });
  const e = evaluate(trace(rev), 0);
  ok(e.events[0].type === 'TARGET_WRONG_ORDER' && e.events[0].id === 'T2', '순서가 뒤바뀌면 먼저 지나간 노랑은 "순서 틀림"', JSON.stringify(e.events.map((x) => x.type + x.id)));
  const first = evaluate(trace(rev), 0);
  ok(first.progress === 1, '뒤바뀐 경로: 지나간 순서상 노랑(순서1)은 무시, 빨강(순서0)만 인정', JSON.stringify(first));
  ok(evaluate(trace(sc), 1).progress === 2, '이미 활성화된 타깃은 건너뛰고 이어서');
  const near_miss = trace(empty({ targets: [{ id: 'T1', order: 0, color: 'red', x: 300, y: 440, r: 30 }] }));
  ok(near_miss.hits.length === 0, '반지름 밖(40px)은 맞지 않음');
}

console.log('5. 레벨: 해 존재 · 시작 배치는 정답 아님 · 정답은 5° 격자 위');
for (const lv of LEVELS) {
  ok(verifyLevel(lv), `${lv.name}: 정답 각도로 한 발에 클리어`);
  ok(!clearsFrom(lv.scene, 0), `${lv.name}: 시작 배치는 정답이 아님`);
  ok(Object.values(lv.solution).every((a) => a % SNAP === 0), `${lv.name}: 정답 각도가 ${SNAP}° 단위`);
  const hands = lv.scene.mirrors.filter((m) => m.kind === 'hand');
  ok(hands.every((m) => lv.solution[m.id] !== undefined), `${lv.name}: 손 거울마다 정답 각도가 있음`);
}

console.log('6. 난이도: 5° 단위 전수 탐색으로 정답 개수 세기');
for (const lv of LEVELS) {
  const ids = lv.scene.mirrors.filter((m) => m.kind === 'hand').map((m) => m.id);
  const sols = solveAngles(lv.scene, ids, 0, SNAP);
  const total = Math.pow(180 / SNAP, ids.length);
  console.log(`     ${lv.name}: 전체 ${total}가지 중 한 발에 클리어되는 배치 ${sols.length}가지`, JSON.stringify(sols.map((x) => x.angles)));
  ok(sols.length >= 1 && sols.length <= 3, `${lv.name}: 정답이 1~3가지 (너무 쉽지도, 불가능하지도 않음)`);
}
{
  // 손 기울기를 5° 단위로 끊을 때, 정답 ±2.4° 안의 손 각도는 정답으로 읽힘 (손 떨림 허용)
  let good = true;
  for (let a = -2.4; a <= 2.4; a += 0.1) if (snapAngle(135 + a) !== 135 || snapAngle(20 + a) !== 20) good = false;
  ok(good, '정답 ±2.4° 이내의 손 각도는 정답으로 스냅 (손 떨림 허용)');
  ok(snapAngle(177.6) === 0 && snapAngle(-1) === 0 && snapAngle(92.4) === 90, '180° 주기 처리 (177.6° → 0°)');
}

console.log('7. 여러 발에 걸친 진행 (MISSION 03)');
{
  const lv = LEVELS[2];
  const shot1 = evaluate(trace(withAngles(lv.scene, { H1: 20, H2: 0 })), 0);
  ok(shot1.progress === 2, '1발: 왼손만 맞으면 빨강·노랑까지 활성화', JSON.stringify(shot1.events.map((e) => e.id)));
  const shot2 = evaluate(trace(withAngles(lv.scene, { H1: 20, H2: 135 })), shot1.progress);
  ok(shot2.progress === 3, '2발: 오른손을 고치면 파랑까지 → 클리어');
  const oneShot = evaluate(trace(withAngles(lv.scene, lv.solution)), 0);
  ok(oneShot.progress === 3 && oneShot.events.length === 3, '원샷 클리어도 가능 (한 발에 세 타깃)');
  const wrong = evaluate(trace(withAngles(lv.scene, { H1: 90, H2: 135 })), 0);
  ok(wrong.progress === 0, '왼손이 틀리면 아무것도 활성화되지 않음');
}

console.log('8. 진단·처방');
{
  const lv = LEVELS[2];
  const bad = withAngles(lv.scene, { H1: 25, H2: 120 });
  ok(!clearsFrom(bad, 0), '각도가 어긋나면 실패');
  const d = diagnose(lv, bad, 0);
  ok(d.solved && d.deltas.length === 2, '두 거울 모두 처방', JSON.stringify(d.deltas));
  const h1 = d.deltas.find((x) => x.id === 'H1'), h2 = d.deltas.find((x) => x.id === 'H2');
  ok(h1 && h1.delta === -5 && h2 && h2.delta === 10, 'H1은 시계 5°, H2는 반시계 10° (가장 적게 돌리는 정답: 130°)', JSON.stringify(d.deltas));
  const fixedScene = withAngles(bad, Object.fromEntries(d.deltas.map((x) => [x.id, x.to])));
  ok(clearsFrom(fixedScene, 0), '처방대로 돌리면 실제로 성공');
  console.log('     처방 문장:', diagnosisText(d));
  const d0 = diagnose(lv, withAngles(lv.scene, lv.solution), 0);
  ok(d0.solved && d0.deltas.length === 0 && /거의 다/.test(diagnosisText(d0)), '이미 맞았으면 처방 없음');
  // 이어서(빨강·노랑 활성화 뒤) 파랑만 남은 경우의 처방
  const d2 = diagnose(lv, withAngles(lv.scene, { H1: 20, H2: 0 }), 2);
  ok(d2.solved && d2.deltas.length === 1 && d2.deltas[0].id === 'H2' && [130, 135, 140].includes(d2.deltas[0].to), '진행 상태를 반영: 파랑만 남았으니 오른손만 정답 범위(130~140°)로', JSON.stringify(d2.deltas));
}

console.log('9. 타이머 · 발사 횟수 규칙 값');
for (const lv of LEVELS) ok(lv.tutorial || (lv.timeLimit > 0 && lv.maxShots > 0), `${lv.name}: 제한시간 ${lv.timeLimit}s · 최대 ${lv.maxShots}발`);
ok(LEVELS[2].timeLimit === 45 && LEVELS[2].maxShots === 5, 'MISSION 03: 45초 · 5발 (설계서와 동일)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
