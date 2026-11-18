// 브라우저 손 인식 계산(handmath.js) 테스트: 각도·펴짐 비율·쥠 히스테리시스·서버 메시지 호환. 실행: node tests/laser_handmath_test.mjs
import { fingerLineAngle, candidates, FistTracker, buildMessage, GRAB_CLOSE, GRAB_OPEN } from '../src/laser/handmath.js';
import { LaserInput } from '../src/laser/input.js';
import { LEVELS } from '../src/laser/levels.js';

let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  ' + x); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

console.log('1. 손가락 기울기 (화면에 보이는 각도, 거울 모드)');
ok(near(fingerLineAngle(0.5, 0.8, 0.5, 0.6), 90), '손가락이 위 → 90°');
ok(near(fingerLineAngle(50, 80, 40, 60), Math.atan2(20, 10) * 180 / Math.PI), '내 오른쪽으로 기울이면(카메라 영상에서는 왼쪽) 화면에서는 위-오른쪽 = 63.4°');
ok(near(fingerLineAngle(50, 80, 40, 60, false), 180 - Math.atan2(20, 10) * 180 / Math.PI), '거울 끄면 반대(116.6°)');
ok(near(fingerLineAngle(50, 50, 60, 50), 180) || near(fingerLineAngle(50, 50, 60, 50), 0), '수평은 0° 또는 180° (같은 선)');
ok(fingerLineAngle(50, 80, 50, 100) === 90, '아래를 가리켜도 같은 선 → 90° (180° 주기)');
{
  let allRange = true;
  for (let a = 0; a < 360; a += 7) { const r = a * Math.PI / 180; const v = fingerLineAngle(0, 0, Math.cos(r) * 10, -Math.sin(r) * 10, false); if (!(v >= 0 && v < 180)) allRange = false; }
  ok(allRange, '모든 방향에서 각도가 0~180° 안');
}

console.log('2. 후보 손: 위치·펴짐 비율');
const mkHand = (cx, cy, ratio, tiltDx = 0) => {
  const lms = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  lms[0] = { x: cx, y: cy + 0.15, z: 0 };                                   // 손목
  [5, 9, 13, 17].forEach((j, k) => { lms[j] = { x: cx + [-0.04, 0, 0.03, 0.06][k] + (j === 9 ? tiltDx : 0), y: cy, z: 0 }; });   // 가운뎃손가락(9) 뿌리는 손목 바로 위 (+ 기울임)
  const world = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  [[5, 8], [9, 12], [13, 16], [17, 20]].forEach(([m, t], k) => { world[m] = { x: 0, y: -0.05, z: 0 }; world[t] = { x: 0, y: -0.05 * ratio, z: 0 }; });
  return { lms, world };
};
{
  const a = mkHand(0.3, 0.5, 1.9), b = mkHand(0.7, 0.5, 1.0);
  const res = { landmarks: [a.lms, b.lms], worldLandmarks: [a.world, b.world] };
  const c = candidates(res, 640, 360, { mirror: true });
  ok(c.length === 2 && near(c[0].open, 1.9, 0.02) && near(c[1].open, 1.0, 0.02), '펴짐 비율: 쫙 편 손 1.9 · 주먹 1.0', c.map((x) => x.open.toFixed(2)).join());
  ok(c[0].nx > 0 && c[1].nx < 0, '거울 모드: 카메라 영상 왼쪽(0.3)에 있는 손이 화면 오른쪽(nx>0)');
  ok(candidates(res, 640, 360, { mirror: false })[0].nx < 0, '거울 끄면 반대');
  ok(c.every((x) => Math.abs(x.nx) <= 1.5 && Math.abs(x.ny) <= 1.5), '위치는 ±1.5 안으로 제한');
  ok(near(c[0].ang, 90, 0.5), '곧게 편 손 90°');
  ok(candidates({ landmarks: [], worldLandmarks: [] }, 640, 360).length === 0 && candidates(null, 640, 360).length === 0, '손이 없으면 빈 목록');
}
{
  const t = mkHand(0.5, 0.5, 1.6, -0.1);       // 가운뎃손가락 뿌리가 영상 왼쪽으로 → 화면에서는 오른쪽으로 기울어짐
  const c = candidates({ landmarks: [t.lms], worldLandmarks: [t.world] }, 640, 360)[0];
  ok(c.ang < 90 && c.ang > 40, '손가락을 내 오른쪽으로 기울이면 각도가 90°보다 작아짐', c.ang.toFixed(1));
}

console.log('3. 쥠 히스테리시스 (경계 1.20 / 1.40, 연속 2프레임)');
{
  const ft = new FistTracker();
  const one = (open) => ft.update([{ open }])[0].fist;
  ok(!one(1.6) && !one(1.6) && !one(1.6), '편한 손은 쥠 아님');
  ok(!one(1.0), '한 프레임만 작아져서는 아직 쥠 아님 (순간 오인식 무시)');
  ok(one(1.0), '연속 2프레임 → 쥠');
  ok(one(1.3) && one(1.3) && one(1.3), '1.2~1.4 사이에서는 쥠 유지');
  ok(one(1.5) && !one(1.5), '1.4 넘게 2프레임 → 폄');
  ok(GRAB_CLOSE === 1.2 && GRAB_OPEN === 1.4, 'config.yaml 의 grab_close/grab_open 과 같은 값');
  ft.reset();
  const two = ft.update([{ open: 1.0 }, { open: 1.7 }]);
  ok(two[0].fist === true && two[1].fist === false, '손 수가 바뀌면 현재 상태로 새로 시작 (한 손 쥠 / 한 손 폄)');
}

console.log('4. 서버 /hand 메시지와 호환 (LaserInput이 그대로 받음)');
{
  const l = mkHand(0.3, 0.5, 1.6, 0), r = mkHand(0.7, 0.5, 1.0, 0);
  const cands = candidates({ landmarks: [l.lms, r.lms], worldLandmarks: [l.world, r.world] }, 640, 360).sort((a, b) => a.nx - b.nx);
  new FistTracker().update(cands);
  const msg = buildMessage(cands, { fps: 30 });
  ok(msg.available && msg.visible && msg.hands.length === 2 && msg.hands[0].nx < msg.hands[1].nx, '메시지: 두 손, 화면 왼쪽부터');
  ok(msg.hands.every((h) => ['nx', 'ny', 'd', 'ang', 'open', 'fist'].every((k) => k in h)), '손마다 nx·ny·d·ang·open·fist');
  ok(buildMessage([]).visible === false && buildMessage([]).hands.length === 0, '손이 없으면 visible=false, hands=[]');
  let now = 0;
  const inp = new LaserInput({ useHand: false, clock: () => now });
  inp.setLevel(LEVELS[3].scene);
  for (let i = 0; i < 20; i++) { now += 1 / 30; inp.onData(msg); }
  ok(inp.handsVisible === 2 && inp.slots.H1.tracked && inp.slots.H2.tracked, 'LaserInput: 두 손이 H1·H2에 연결');
  ok(inp.slots.H1.angle % 5 === 0 && inp.slots.H2.angle % 5 === 0, '각도가 5° 단위로 스냅');
  ok(inp.slots.H1.fist === true && inp.slots.H2.fist === false, '쥠 상태가 전달됨 (카메라 영상 오른쪽 = 화면 왼쪽 손이 쥠)');
  ok(Math.abs(inp.slots.H1.angle - 90) <= 5, '곧게 편 손 → 90° 근처', String(inp.slots.H1.angle));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
