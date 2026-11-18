// 입력 모듈 시뮬레이션 테스트 (가상 시간). 실행: node tests/laser_input_test.mjs
import { LaserInput } from '../src/laser/input.js';
import { LEVELS, cloneScene } from '../src/laser/levels.js';

let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
let T = 100;
const mk = (lv = 2) => { const fires = []; const inp = new LaserInput({ useHand: false, clock: () => T, onFire: (f) => fires.push(f) }); inp.setLevel(LEVELS[lv].scene); return { inp, fires }; };
const msg = (hands) => ({ available: true, visible: hands.length > 0, hands });
const H = (nx, ang, fist = false) => ({ nx, ny: 0, ang, fist, open: fist ? 1 : 1.9, d: 0.7 });
const rnd = (a) => (Math.random() * 2 - 1) * a;
const run = (inp, sec, fn, fps = 30) => { for (let i = 0; i < sec * fps; i++) { T += 1 / fps; inp.onData(msg(fn(i / fps))); } };

console.log('1. 손 떨림에도 각도가 안 흔들림');
{
  const { inp } = mk();
  let changes = 0, last = inp.slots.H1.angle;
  run(inp, 0.5, () => [H(-0.5, 20 + rnd(2)), H(0.5, 135 + rnd(2))]);
  last = inp.slots.H1.angle; const l2 = inp.slots.H2.angle;
  run(inp, 3, () => [H(-0.5, 20 + rnd(2.2)), H(0.5, 135 + rnd(2.2))]);
  // 3초 동안 바뀐 횟수 세기 위해 다시
  const seq = [];
  run(inp, 3, () => { seq.push(inp.slots.H1.angle); return [H(-0.5, 20 + rnd(2.2)), H(0.5, 135 + rnd(2.2))]; });
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) changes++;
  ok(inp.slots.H1.angle === 20 && inp.slots.H2.angle === 135, '±2° 떨려도 20° / 135° 로 안정', `${inp.slots.H1.angle}, ${inp.slots.H2.angle}`);
  ok(changes === 0, `3초(90프레임) 동안 값이 바뀐 횟수 0`, `changes=${changes}`);
}
console.log('2. 0°/180° 경계');
{
  const { inp } = mk();
  const seq = [];
  run(inp, 3, () => { seq.push(inp.slots.H1.angle); return [H(-0.5, (180 + rnd(2.5) + 180) % 180), H(0.5, 90)]; });
  ok(inp.slots.H1.angle === 0 && seq.slice(10).every((a) => a === 0), '178°~2° 사이에서 떨려도 0°로 안정 (180° 주기)', `${[...new Set(seq)]}`);
}
console.log('3. 천천히 돌리면 따라감 · 히스테리시스');
{
  const { inp } = mk();
  run(inp, 0.4, () => [H(-0.5, 20), H(0.5, 135)]);
  run(inp, 0.4, () => [H(-0.5, 22.4), H(0.5, 135)]);
  ok(inp.slots.H1.angle === 20, '22.4°는 아직 20° (경계 근처에서 바로 안 바뀜)', inp.slots.H1.angle);
  run(inp, 0.6, () => [H(-0.5, 27), H(0.5, 135)]);
  ok(inp.slots.H1.angle === 25, '27°는 25°', inp.slots.H1.angle);
  run(inp, 1.0, () => [H(-0.5, 60), H(0.5, 135)]);
  ok(inp.slots.H1.angle === 60, '60°로 돌리면 60°', inp.slots.H1.angle);
}
console.log('4. 손 배정');
{
  const { inp } = mk();
  run(inp, 0.5, () => [H(-0.6, 40), H(0.6, 100)]);
  ok(inp.slots.H1.angle === 40 && inp.slots.H2.angle === 100, '두 손: 왼쪽 손 → H1, 오른쪽 손 → H2', `${inp.slots.H1.angle}/${inp.slots.H2.angle}`);
  const b = mk();
  run(b.inp, 0.5, () => [H(-0.6, 40)]);
  ok(b.inp.slots.H1.tracked && !b.inp.slots.H2.tracked && b.inp.slots.H1.angle === 40, '한 손이 왼쪽 → H1');
  run(b.inp, 0.5, () => [H(0.6, 100)]);
  ok(b.inp.slots.H2.tracked && b.inp.slots.H2.angle === 100 && b.inp.slots.H1.angle === 40, '같은 손이 오른쪽으로 → H2 조종, H1은 각도 유지', `${b.inp.slots.H1.angle}/${b.inp.slots.H2.angle}`);
  run(b.inp, 0.5, () => [H(0.02, 70)]);
  ok(b.inp.slots.H2.angle === 70, '가운데에서는 직전에 쓰던 거울(H2) 유지', b.inp.slots.H2.angle);
  const c = mk(0);
  run(c.inp, 0.5, () => [H(0.6, 30)]);
  ok(c.inp.slots.H1.angle === 30, '거울이 하나뿐인 레벨: 손이 어디 있든 H1', c.inp.slots.H1.angle);
}
console.log('5. 주먹 → 발사 · 쥐기 직전 각도로 고정');
{
  const { inp, fires } = mk();
  run(inp, 1.0, () => [H(-0.5, 40), H(0.5, 135)]);
  // 주먹을 쥐면서 손이 흐트러짐: 0.3초 동안 각도가 40 → 75 로 쏠림, 마지막 프레임에서 fist=true
  const n = 9;
  for (let i = 0; i < n; i++) { T += 1 / 30; inp.onData(msg([H(-0.5, 40 + (35 * (i + 1)) / n, i >= n - 2), H(0.5, 135)])); }
  ok(fires.length === 1 && fires[0].slot === 'H1' && fires[0].via === 'fist', '주먹을 쥐는 순간 한 번 발사', JSON.stringify(fires));
  ok(inp.slots.H1.angle === 40, '발사 각도 = 쥐기 직전 각도(40°) — 쥐면서 흐트러진 75° 아님', inp.slots.H1.angle);
  run(inp, 0.3, () => [H(-0.5, 80, true), H(0.5, 135)]);
  ok(inp.slots.H1.angle === 40 && fires.length === 1, '주먹을 쥐고 있는 동안 각도 고정, 추가 발사 없음');
  run(inp, 0.1, () => [H(-0.5, 40, false), H(0.5, 135)]);      // 첫 발사 후 약 0.4초
  run(inp, 0.1, () => [H(-0.5, 40, true), H(0.5, 135)]);
  ok(fires.length === 1, '0.7초 쿨다운 안의 연속 주먹은 무시', fires.length);
  run(inp, 1.0, () => [H(-0.5, 40, false), H(0.5, 135)]);
  run(inp, 0.1, () => [H(-0.5, 40, true), H(0.5, 135)]);
  ok(fires.length === 2, '쿨다운이 지나면 다시 발사', fires.length);
  const b = mk();
  run(b.inp, 0.5, () => [H(-0.5, 40, true), H(0.5, 135)]);
  ok(b.fires.length === 0, '처음부터 주먹인 손은 발사하지 않음');
}
console.log('6. 손 놓침 · 복귀 · 마우스/키보드');
{
  const { inp } = mk();
  run(inp, 0.5, () => [H(-0.5, 40), H(0.5, 135)]);
  T += 0.8; inp.update();
  ok(!inp.slots.H1.tracked && inp.slots.H1.angle === 40, '0.8초 못 보면 tracked=false, 각도는 유지');
  ok(!inp.anyTracked && inp.source === 'mouse', '손이 없으면 입력 원천은 mouse');
  run(inp, 0.3, () => [H(-0.5, 40), H(0.5, 135)]); inp.update();
  ok(inp.slots.H1.tracked && inp.source === 'hand', '손이 돌아오면 다시 추적');
  inp.onData({ available: true, visible: false, hands: [] });
  ok(inp.handsVisible === 0, 'hands=[] 이면 보이는 손 0개');
  inp.onData({ available: false });
  ok(inp.handsVisible === 0, '손 인식 꺼짐(available=false)');
  const k = mk(); const before = k.inp.slots.H1.angle;
  k.inp.rotate('H1', 1); ok(k.inp.slots.H1.angle === (before + 5) % 180, '키보드: 반시계로 5° (한 칸)');
  k.inp.rotate('H1', -1); k.inp.rotate('H1', -1); ok(k.inp.slots.H1.angle === (before - 5 + 180) % 180, '키보드: 시계로 5°');
  k.inp.cycle(); ok(k.inp.active === 'H2', 'Tab: 조종할 거울 바꾸기');
  k.inp.manualFire(); ok(k.fires.length === 1 && k.fires[0].via === 'key', '스페이스/클릭: 발사');
  const m = mk(); m.inp.onData({ available: true, visible: true, nx: 0, ny: 0, grab: false });   // 예전 서버(hands 없음)
  ok(m.inp.handsVisible === 1, '예전 서버 형식(hands 없음)도 손 1개로 인식');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
