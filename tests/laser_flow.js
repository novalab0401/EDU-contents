// 레이저 챌린지 전체 흐름 테스트 (브라우저 안에서 실행, 시간은 가상으로 진행).
// 서버를 켜고 브라우저로 열기:  http://localhost:8001/laser.html?manual&test=flow   → 화면에 결과가 나오고, 제목이 "DONE pass/fail"로 바뀜
// (주의: 이 테스트는 서버에 테스트 기록을 남김. 전시 전에 data/leaderboard.db 를 지우거나, 위치 CHAOS_DB 로 임시 DB를 쓰세요)
const L = window.laser;
const out = document.createElement('pre');
out.id = 'test-out';
out.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;margin:0;padding:10px;background:rgba(0,0,0,.85);color:#cfe;font:13px/1.35 monospace;max-height:96vh;overflow:auto;max-width:60vw';
document.body.appendChild(out);
let pass = 0, fail = 0;
const say = (s) => { out.textContent += s + '\n'; };
const ok = (c, n, x = '') => { if (c) { pass++; say('  ✓ ' + n); } else { fail++; say('  ✗ ' + n + '  ' + x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (code, target = window) => target.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
const open = (nx, ang, id = 0) => ({ nx, ny: 0, ang, fist: false, open: 1.9, d: 0.7 });
const fist = (h) => ({ ...h, fist: true, open: 1.0 });
/** 손 메시지를 sec초 동안 30fps로 계속 보냄 */
const feed = (sec, hands) => { const n = Math.max(1, Math.round(sec * 30)); for (let i = 0; i < n; i++) { L.hands(typeof hands === 'function' ? hands(i) : hands); L.step(1 / 30, i === n - 1); } };
const waitShot = () => { for (let i = 0; i < 400 && L.R && L.R.fire; i++) L.step(1 / 30, false); L.step(1 / 30, true); };
const events = (type) => L.R.events.filter((e) => e.type === type);

async function toPlay() {                // 튜토리얼 건너뛰고 MISSION 03 시작 → 카운트다운 끝
  L.start([1, 3]);
  key('KeyN');                           // 튜토리얼 건너뛰기
  L.advance(CLEAR + 0.3);
  L.advance(4.2);
}
const CLEAR = 1.8;

async function main() {
  say('레이저 챌린지 흐름 테스트\n');

  say('1. 대기 화면 · 데모');
  L.advance(0.5);
  ok(L.G.state === 'title', '처음엔 대기 화면');
  let maxP = 0; for (let i = 0; i < 40; i++) { L.advance(0.5); maxP = Math.max(maxP, L.G.demo.progress); }
  ok(maxP === 3, '데모가 스스로 풀어서 세 타깃을 순서대로 맞힘', 'max=' + maxP);
  ok(L.sfx.log.length === 0, '대기 화면 데모에서는 소리가 나지 않음');

  ok(L.sfx.bgmMode === 'calm', '대기 화면 배경음악: 잔잔한 모드', L.sfx.bgmMode);
  say('2. 손으로 난이도 고르기 (카드 위에 1초 머무르기) — 손만 보인다고 저절로 시작하지 않음');
  const onCard = (i) => ({ ...open(0, 90), ...L.menuHand(i) });
  feed(3.0, [open(0, 90)]);
  ok(L.G.state === 'title', '손이 3초 동안 보여도 카드 밖이면 계속 대기 (자동 시작 없음)', L.G.state);
  feed(0.6, [onCard(2)]);
  ok(L.G.state === 'title' && L.G.hover === 2, '카드 위 0.6초: 아직 선택 중', L.G.state);
  feed(0.6, [onCard(2)]);
  ok(L.G.state === 'tutorial' && L.G.plan.join() === '1,4', '카드(어려움) 위 1초 → 튜토리얼 → MISSION 04', L.G.state + ' ' + L.G.plan);
  ok(L.R.level.id === 1 && L.R.scene.mirrors.length === 1, 'MISSION 01 (거울 1개)');
  key('Escape');
  feed(0.3, []);
  feed(1.2, [onCard(0)]);
  ok(L.G.state === 'tutorial' && L.G.plan.join() === '1,2', '쉬움 카드 → 튜토리얼 → MISSION 02', L.G.plan + '');
  key('Escape');
  feed(0.3, []);
  feed(1.2, [onCard(4)]);
  ok(L.G.state === 'title' && L.G.liveSel === true, 'LIVE 칩 위 1초 → LIVE 모드 켜짐 (시작은 안 함)', L.G.state + ' ' + L.G.liveSel);
  feed(1.5, [onCard(4)]);
  ok(L.G.liveSel === true, '칩 위에 계속 있어도 다시 토글되지 않음');
  feed(0.3, [open(0, 90)]); feed(1.2, [onCard(4)]);
  ok(L.G.liveSel === false, '손이 나갔다 다시 들어오면 토글(꺼짐)');
  feed(0.3, []);

  say('2b. 처음 화면으로 돌아왔을 때 이전 사람이 같은 카드 위에 손을 들고 있으면 바로 시작하지 않음');
  feed(1.2, [onCard(2)]);
  ok(L.G.state === 'tutorial', '카드 선택으로 시작', L.G.state);
  key('Escape');
  feed(1.5, [onCard(2)]);                          // 손이 같은 카드 위에 계속 있음
  ok(L.G.state === 'title', '손이 카드 위에 계속 있는 동안은 대기', L.G.state);
  feed(0.3, [open(0, 90)]);                        // 카드 밖으로 한 번 나가면
  feed(1.2, [onCard(2)]);
  ok(L.G.state === 'tutorial', '카드 밖으로 나갔다 다시 들어오면 시작', L.G.state);

  say('3. 튜토리얼: 손 기울기 → 거울, 주먹 → 발사');
  feed(1.2, [open(0, 25)]);
  ok(L.input.slots.H1.angle === 25 && L.R.scene.mirrors[0].angle === 25, '손 기울기 25° → 거울 25°', String(L.input.slots.H1.angle));
  ok(L.R.tr.hits.length > 0, '점선 미리보기가 타깃을 지나감');
  ok(events('MIRROR_SELECTED').length === 1, 'MIRROR_SELECTED 기록');
  feed(0.2, [open(0, 25)]);
  for (let i = 0; i < 9; i++) feed(1 / 30, [i >= 7 ? fist(open(0, 25 + (i + 1) * 4)) : open(0, 25 + (i + 1) * 4)]);     // 쥐면서 각도가 흐트러짐
  ok(L.R.fire !== null || L.R.shotsUsed === 1, '주먹을 쥐면 발사', JSON.stringify(L.snapshot()));
  ok(L.R.lastShotAngles && L.R.lastShotAngles.H1 === 25, '발사 각도는 쥐기 직전의 25° (흐트러진 각도 아님)', JSON.stringify(L.R.lastShotAngles));
  waitShot();
  ok(L.G.state === 'tutorial_clear' && L.R.progress === 1, '타깃을 맞히면 튜토리얼 클리어', JSON.stringify(L.snapshot()));
  ok(L.sfx.log.includes('fire') && L.sfx.log.includes('hit0'), '발사음 · 명중음 재생 요청');
  L.advance(2.0);
  ok(L.G.state === 'brief' && L.R.level.id === 4, '이어서 기본 미션 MISSION 04 브리핑 (타깃 4개 · 60초 · 6발)');
  key('Escape'); L.start([1, 3]); key('KeyN'); L.advance(CLEAR + 0.3);   // 이후 구간은 MISSION 03 (3타깃)으로 계속

  say('4. 카운트다운 → 본 게임 (45초 · 5발)');
  L.advance(3.0);
  ok(L.G.state === 'brief', '3초까지는 브리핑');
  L.advance(1.1);
  ok(L.G.state === 'play' && L.R.timeLeft > 44 && L.R.timeLeft <= 45 && L.R.level.maxShots === 5, '4초 뒤 시작: 45초 · 5발', JSON.stringify(L.snapshot()));
  ok(L.sfx.bgmMode === 'play', '본 게임 중에는 배경음악이 비트 모드', L.sfx.bgmMode);

  say('5. 두 발로 클리어: 왼손만 맞게 → 두 번째 발에 오른손 수정');
  L.setAngles({ H1: 20, H2: 0 });
  L.advance(5);
  const t0 = L.R.timeLeft;
  L.fireNow({ via: 'test' });
  ok(L.R.fire && L.R.shotsUsed === 1, '발사 1');
  L.fireNow({ via: 'test' });
  ok(L.R.shotsUsed === 1, '레이저가 나가는 동안 또 쏠 수 없음');
  waitShot();
  ok(L.R.progress === 2 && L.G.state === 'play', '1발: 빨강·노랑 활성화, 게임 계속', JSON.stringify(L.snapshot()));
  L.setAngles({ H2: 135 });
  L.advance(3);
  L.fireNow({ via: 'test' });
  waitShot();
  const s = L.snapshot();
  ok(s.state === 'celebrate' && s.cleared && s.progress === 3, '2발: 파랑까지 → 클리어', JSON.stringify(s));
  const expected = 3000 + Math.round(L.R.timeLeft) * 10 + 3 * 150;
  ok(s.score === expected, `점수 = 3000 + 남은 시간×10 + 남은 발수×150 = ${expected}`, String(s.score));
  ok(s.stars === 3, '별 3개 (2발 이하 + 15초 이상 남음)', String(s.stars));
  ok(events('SHOT_FIRED').length === 2 && events('TARGET_HIT').length === 3 && events('MISSION_END').length === 1, '이벤트 로그: 발사 2 · 명중 3 · 종료 1');
  const sf = events('SHOT_FIRED')[0];
  ok(sf.angles.H1 === 20 && sf.angles.H2 === 0 && Array.isArray(sf.path), 'SHOT_FIRED에 거울 각도 스냅샷과 광선 경로가 들어 있음');
  ok(events('ANGLE_CHANGED').length >= 1, 'ANGLE_CHANGED 기록');
  const times = L.R.events.map((e) => e.t);
  ok(times.every((t, i) => i === 0 || t >= times[i - 1]), '로그 타임스탬프가 단조 증가');
  L.advance(3.0);
  ok(L.G.state === 'card', '축하 뒤 결과 카드');
  await sleep(700);
  ok(L.R.playId > 0 && L.R.qualifies, '서버에 기록되고 오늘의 챔피언 후보', JSON.stringify({ id: L.R.playId, q: L.R.qualifies }));
  ok(!document.getElementById('r-name-row').classList.contains('hidden'), '이름 입력칸이 보임');
  ok(document.getElementById('r-name').value.length > 0, '이름이 미리 채워져 있음 (아이들이 안 쳐도 됨)');
  document.getElementById('r-name').value = '테스트';
  L.saveName();
  await sleep(700);
  ok([...document.querySelectorAll('#r-lb li .nm')].some((e) => e.textContent === '테스트'), '저장하면 오늘의 챔피언 목록에 나타남');
  ok(document.getElementById('r-name-row').classList.contains('hidden'), '저장 뒤 이름칸이 사라짐');
  key('Enter');
  ok(L.G.state === 'title' && document.getElementById('result').classList.contains('hidden'), 'Enter → 처음 화면');

  say('6. 시간 초과 → 진단·처방');
  await toPlay();
  L.setAngles({ H1: 25, H2: 130 });
  L.advance(46);
  ok(L.G.state === 'review' && L.R.endReason === 'time' && !L.R.cleared, '45초가 지나면 실패(시간 초과)', JSON.stringify(L.snapshot()));
  ok(L.R.score === 0 && L.R.stars === 0, '아무것도 못 맞히면 0점');
  ok(/왼손 거울: 시계 방향으로 5° 더/.test(L.R.diagText) && !/오른손/.test(L.R.diagText), '처방: 왼손 거울을 시계 방향으로 5° (오른손은 이미 130°로 정답 범위)', L.R.diagText);
  ok(L.sfx.log.includes('lose'), '실패음');
  L.advance(7.5);
  ok(L.G.state === 'card', '처방 확인 뒤 결과 카드');
  await sleep(500);
  ok(L.R.qualifies === false, '0점은 명예의 전당 후보가 아님');
  ok(document.getElementById('r-diag').textContent.includes('시계 방향'), '결과 카드에도 처방이 보임');
  key('Enter');

  say('7. 발사 5번 소진');
  await toPlay();
  L.setAngles({ H1: 20, H2: 0 });
  for (let i = 0; i < 5; i++) { L.advance(0.8); L.fireNow({ via: 'test' }); waitShot(); }
  ok(L.G.state === 'review' && L.R.endReason === 'shots' && L.R.shotsUsed === 5, '5발을 다 쓰면 종료', JSON.stringify(L.snapshot()));
  ok(L.R.progress === 2 && L.R.score === 2000, '맞힌 만큼만 점수 (2타깃 = 2000점)', String(L.R.score));
  ok(/오른손 거울: 시계 방향으로 40° 더/.test(L.R.diagText), '처방: 오른손을 시계 40° (0° → 140°)', L.R.diagText);
  L.fireNow({ via: 'test' });
  ok(L.R.shotsUsed === 5, '종료 뒤에는 쏠 수 없음');
  key('Escape');
  ok(L.G.state === 'title', 'Esc → 처음 화면');

  say('8. 두 손으로 원샷 클리어 (손 → 거울, 주먹 → 발사)');
  L.start([1, 3]); key('KeyN'); L.advance(CLEAR + 0.3); L.advance(4.2);
  ok(L.G.state === 'play', '본 게임 시작');
  feed(0.8, [open(-0.5, 20), open(0.5, 135)]);
  ok(L.input.slots.H1.angle === 20 && L.input.slots.H2.angle === 135 && L.input.slots.H1.tracked && L.input.slots.H2.tracked, '왼손 20° · 오른손 135°가 각 거울에 연결');
  feed(0.3, [fist(open(-0.5, 20)), open(0.5, 135)]);
  ok(L.R.shotsUsed === 1, '왼손 주먹 → 발사');
  waitShot();
  ok(L.G.state === 'celebrate' && L.R.badge === 'ONE SHOT' && L.R.stars === 3, '한 발에 세 타깃 = ONE SHOT 배지 · 별 3개', JSON.stringify(L.snapshot()));
  ok(L.R.score === 3000 + Math.round(L.R.timeLeft) * 10 + 4 * 150, '점수 = 3000 + 시간 + 남은 발수 4×150');
  key('Escape');

  say('9. 손을 놓쳤을 때 · 되돌아왔을 때');
  L.start([1, 3]); key('KeyN'); L.advance(CLEAR + 0.3); L.advance(4.2);
  feed(0.6, [open(-0.5, 40), open(0.5, 100)]);
  feed(2.0, []);                              // 서버는 손이 없어도 카메라 프레임마다 "손 없음" 메시지를 계속 보냄
  ok(!L.input.slots.H1.tracked && L.input.slots.H1.angle === 40 && L.R.scene.mirrors.find((m) => m.id === 'H1').angle === 40, '손이 사라져도 거울 각도 유지');
  ok(L.G.lostT > 1.2, '"손을 보여주세요" 안내가 뜰 조건 (손이 1.2초 넘게 안 보임)');
  feed(0.4, [open(-0.5, 60), open(0.5, 100)]);
  ok(L.input.slots.H1.tracked && L.G.lostT === 0, '손이 돌아오면 다시 조종');
  key('Escape');

  say('10. 운영자 키 · 키보드 조작 · 쉬운 모드');
  key('Digit2');
  ok(L.G.state === 'tutorial' && L.G.plan.join() === '1,2', '2 키: 쉬운 모드 (튜토리얼 → MISSION 02)');
  const a0 = L.input.slots.H1.angle;
  key('ArrowLeft'); ok(L.input.slots.H1.angle === (a0 + 5) % 180, '← : 반시계 5°');
  key('ArrowRight'); key('ArrowRight'); ok(L.input.slots.H1.angle === (a0 - 5 + 180) % 180, '→ : 시계 5°');
  L.setAngles({ H1: 25 });
  key('Space'); waitShot();
  ok(L.G.state === 'tutorial_clear', 'Space: 발사 → 튜토리얼 클리어');
  L.advance(2.0);
  ok(L.G.state === 'brief' && L.R.level.id === 2 && L.R.level.timeLimit === 60, 'MISSION 02 (60초 · 6발)');
  key('KeyN'); L.advance(0.1);
  ok(L.G.state === 'play', 'N: 브리핑 건너뛰기');
  L.setAngles({ H1: 20, H2: 20 }); L.fireNow({}); waitShot();
  ok(L.G.state === 'celebrate' && L.R.progress === 2, 'MISSION 02 정답(20°·20°)으로 클리어');
  key('Escape');
  ok(L.G.state === 'title', '처음 화면으로');

  say('11. 다시 하기 (R) · 튜토리얼 자동 넘김');
  L.start([1, 3]);
  L.advance(91);
  ok(L.G.state === 'tutorial_clear' || L.G.state === 'brief', '튜토리얼 90초 넘으면 자동으로 본 미션으로', L.G.state);
  key('Escape');

  say('12. 라이브 모드 (L 키): 레이저 상시 ON, 한 빔으로 모든 타깃');
  key('KeyL'); key('Enter');
  ok(L.G.state === 'tutorial' && L.G.live && L.R.live && L.R.level.id === 1, 'L 키로 켜고 Enter: 라이브 모드 튜토리얼');
  ok(events('MISSION_START')[0].mode === 'live', 'MISSION_START 기록에 mode=live');
  L.setAngles({ H1: 25 });
  L.advance(0.3);
  ok(L.G.state === 'tutorial' && L.R.liveProgress === 1, '빔이 타깃에 닿으면 바로 인식하지만 0.5초는 유지해야 함', JSON.stringify(L.snapshot()));
  L.setAngles({ H1: 60 }); L.advance(0.3); L.setAngles({ H1: 25 }); L.advance(0.3);
  ok(L.G.state === 'tutorial', '중간에 빔이 벗어나면 유지 시간이 처음부터 다시');
  L.advance(0.4);
  ok(L.G.state === 'tutorial_clear', '0.5초 유지하면 튜토리얼 클리어', JSON.stringify(L.snapshot()));
  ok(L.R.shotsUsed === 0, '발사 없이 클리어');
  L.advance(2.0);
  ok(L.G.state === 'brief' && L.R.live && L.R.level.id === 4, '다음은 라이브 MISSION 04');
  L.advance(4.2);
  ok(L.G.state === 'play', '카운트다운 뒤 시작');
  L.setAngles({ H1: 150, H2: 0 });
  L.advance(0.5);
  ok(L.R.liveProgress >= 1 && L.R.liveProgress < 4 && L.G.state === 'play', '일부 타깃만 맞으면 계속 진행', JSON.stringify(L.snapshot()));
  const part = L.R.liveProgress;
  L.setAngles({ H1: 90, H2: 125 });
  L.advance(2.0);
  ok(L.R.liveProgress === 0 && L.R.bestProgress === part && L.G.state === 'play', '빔이 벗어나면 liveProgress는 내려가고 최고 기록은 남음', JSON.stringify([L.R.liveProgress, L.R.bestProgress]));
  const before = L.R.shotsUsed;
  feed(0.3, [fist(open(-0.5, 150)), open(0.5, 125)]);
  ok(L.R.shotsUsed === before, '라이브에서는 주먹을 쥐어도 발사되지 않음');
  ok(L.input.slots.H1.frozen || L.input.slots.H1.fist, '주먹 = 각도 고정');
  feed(1.0, [open(-0.5, 150), open(0.5, 125)]);
  ok(L.G.state === 'celebrate' && L.R.cleared, '두 손으로 150°·125° → 한 빔으로 네 타깃 클리어', JSON.stringify(L.snapshot()));
  const tl = L.R.timeLeft;
  ok(L.R.score === 4000 + Math.round(tl) * 10 && L.R.badge === '', '점수 = 4000 + 남은 시간×10 (발사 보너스·ONE SHOT 없음)', String(L.R.score));
  ok(L.R.stars === 1 + (tl >= 15 ? 1 : 0) + (tl >= 28 ? 1 : 0), '별: 남은 시간 기준 (15초·28초 이상)', String(L.R.stars));
  ok(events('TARGET_HIT').filter((e) => e.live).length >= 4, '라이브 TARGET_HIT 기록');
  L.advance(3.0);
  await sleep(900);
  ok(L.G.state === 'card' && /LIVE/.test(document.getElementById('r-title').textContent), '결과 카드에 LIVE 표시');
  ok(!/발사/.test(document.getElementById('r-detail').textContent), '결과 카드 상세에 발사 횟수가 없음', document.getElementById('r-detail').textContent);
  const pl = await (await fetch('/api/laser/plays')).json();
  ok(pl.plays.some((p) => p.id === L.R.playId && p.mission === 14), '서버에는 mission 14(라이브 MISSION 04)로 기록');
  const lb4 = await (await fetch('/api/laser/leaderboard?mission=4')).json();
  ok(!lb4.top.some((r) => r.id === L.R.playId), '발사 모드 순위표(mission 4)에는 섞이지 않음');
  key('Escape');
  ok(L.G.state === 'title' && document.getElementById('result').classList.contains('hidden'), '처음 화면 (결과 카드 닫힘)');

  say('12b. 라이브 모드 실패 → 처음부터 계산한 처방');
  key('Enter'); key('KeyN'); L.advance(CLEAR + 0.3); L.advance(4.2);
  L.setAngles({ H1: 155, H2: 125 });
  L.advance(61);
  ok(L.G.state === 'review' && L.R.endReason === 'time' && L.R.live, '라이브도 60초가 지나면 실패', JSON.stringify(L.snapshot()));
  ok(/왼손 거울: 시계 방향으로 5° 더/.test(L.R.diagText) && !/오른손/.test(L.R.diagText), '처방은 발사 모드와 같은 방식 (왼손 150°로)', L.R.diagText);
  key('Escape');
  ok(L.G.liveSel === true, 'LIVE 선택은 처음 화면으로 돌아와도 유지');
  key('KeyL'); key('Enter');
  ok(L.G.state === 'tutorial' && !L.G.live, 'L 키로 끄고 Enter: 다시 일반(발사) 모드');
  key('Escape');

  say('13. 어려운 레벨 (MISSION 04·05) · 난이도 키');
  key('Digit4');
  ok(L.G.state === 'tutorial' && L.G.plan.join() === '1,4' && !L.G.live, '4 키: 튜토리얼 → MISSION 04');
  key('KeyN'); L.advance(CLEAR + 0.3);
  ok(L.R.level.id === 4 && L.R.scene.targets.length === 4 && L.R.scene.mirrors.length === 5, 'MISSION 04: 타깃 4개 · 거울 5개');
  L.advance(4.2);
  L.setAngles({ H1: 150, H2: 0 }); L.advance(0.2); L.fireNow({ via: 'test' }); waitShot();
  ok(L.R.progress < 4 && L.G.state === 'play', 'H2가 틀리면 한 발에 다 못 맞힘', JSON.stringify(L.snapshot()));
  L.setAngles({ H1: 150, H2: 125 }); L.advance(0.2); L.fireNow({ via: 'test' }); waitShot();
  ok(L.G.state === 'celebrate' && L.R.progress === 4, '정답(150°·125°)으로 네 타깃 클리어', JSON.stringify(L.snapshot()));
  ok(L.R.score >= 4000, '점수 = 타깃 4 × 1000 + 보너스', String(L.R.score));
  key('Escape');
  key('Digit5');
  ok(L.G.plan.join() === '1,5', '5 키: 튜토리얼 → MISSION 05');
  key('KeyN'); L.advance(CLEAR + 0.3); key('KeyN'); L.advance(0.1);
  ok(L.R.level.id === 5 && L.R.scene.targets.length === 5 && L.G.state === 'play', 'MISSION 05: 타깃 5개 (75초 · 6발)', L.G.state);
  L.setAngles({ H1: 30, H2: 40 }); L.advance(0.2); L.fireNow({ via: 'test' }); waitShot();
  ok(L.G.state === 'celebrate' && L.R.progress === 5, '정답(30°·40°)으로 다섯 타깃 클리어', JSON.stringify(L.snapshot()));
  key('Escape');
  key('Enter');
  ok(L.G.plan.join() === '1,4', 'Enter: 기본은 MISSION 04');
  key('Escape');
  key('KeyL'); key('Enter'); key('KeyN'); L.advance(CLEAR + 0.3); L.advance(4.2);
  L.setAngles({ H1: 150, H2: 125 }); L.advance(1.0);
  ok(L.G.state === 'celebrate' && L.R.live && L.R.progress === 4, '라이브 모드도 MISSION 04를 한 빔으로 클리어', JSON.stringify(L.snapshot()));
  key('Escape');

  say(`\n${pass} passed, ${fail} failed`);
  document.title = `DONE ${pass}/${fail}`;
}
main().catch((e) => { say('테스트 오류: ' + (e && e.stack || e)); document.title = 'DONE ERROR'; });
