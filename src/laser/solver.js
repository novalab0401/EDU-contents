// 풀이기: 레벨 검증 + 실패 진단·처방 (같은 광학 엔진으로 각도를 탐색)
import { trace, evaluate, lineDiff, norm180 } from './optics.js';
import { cloneScene, SNAP } from './levels.js';

/** 손 거울 각도를 바꾼 새 장면. cfg = {H1: 20, H2: 135} (각도만) */
export function withAngles(scene, cfg) {
  const s = cloneScene(scene);
  for (const m of s.mirrors) if (cfg[m.id] !== undefined) m.angle = cfg[m.id];
  return s;
}

/** progress까지 활성화된 상태에서, 이 배치로 한 발에 남은 타깃을 모두 활성화하는가 */
export function clearsFrom(scene, progress = 0) {
  const r = evaluate(trace(scene), progress);
  return r.progress === scene.targets.length;
}

/**
 * 손 거울 ids의 각도를 SNAP 단위로 전부 시도해서 한 발에 클리어하는 배치를 찾는다 (손 거울 위치는 고정).
 * 현재 각도에서 가장 적게 돌리는 해부터 돌려줌: [{cost, angles:{id:angle}}]
 */
export function solveAngles(scene, ids, progress = 0, step = SNAP) {
  const cur = ids.map((id) => scene.mirrors.find((m) => m.id === id).angle);
  const sols = [];
  const work = cloneScene(scene);
  const ms = ids.map((id) => work.mirrors.find((m) => m.id === id));
  const rec = (k) => {
    if (k === ids.length) {
      if (clearsFrom(work, progress)) {
        const angles = {};
        let cost = 0;
        ids.forEach((id, i) => { angles[id] = ms[i].angle; cost = Math.max(cost, Math.abs(lineDiff(ms[i].angle, cur[i]))); });
        sols.push({ cost, angles });
      }
      return;
    }
    for (let a = 0; a < 180; a += step) { ms[k].angle = a; rec(k + 1); }
  };
  rec(0);
  sols.sort((a, b) => a.cost - b.cost);
  return sols;
}

/**
 * 실패한 판 진단: 지금 위치에서 각도만 바꿔서 (진행 상태 progress 이후 남은 타깃을 한 발에) 풀리는 배치 중
 * 가장 적게 돌리는 처방을 찾는다. 반환: { deltas:[{id, from, to, delta}], solved:boolean }  (delta + = 반시계)
 */
export function diagnose(level, scene, progress) {
  const ids = scene.mirrors.filter((m) => m.kind === 'hand').map((m) => m.id);
  const sols = solveAngles(scene, ids, progress);
  if (!sols.length) return { solved: false, deltas: [], solution: level.solution };
  const best = sols[0];
  const deltas = ids.map((id) => {
    const cur = scene.mirrors.find((m) => m.id === id).angle;
    return { id, from: norm180(cur), to: best.angles[id], delta: lineDiff(best.angles[id], cur) };
  }).filter((d) => Math.abs(d.delta) >= SNAP / 2);
  return { solved: true, deltas, solution: level.solution };
}

/** 처방을 사람이 읽는 문장으로. 거울 이름은 손 기준 (H1=왼손, H2=오른손) */
export function diagnosisText(diag, names = { H1: '왼손 거울', H2: '오른손 거울' }) {
  if (!diag.solved) return '정답 예시를 확인해 보세요.';
  if (!diag.deltas.length) return '거의 다 맞았어요!';
  return diag.deltas.map((d) => `${names[d.id] || d.id}: ${d.delta > 0 ? '반시계' : '시계'} 방향으로 ${Math.abs(Math.round(d.delta))}° 더`).join('   ·   ');
}

/** 레벨 검증: 정답 각도로 한 발에 클리어되는가 */
export function verifyLevel(level) {
  return clearsFrom(withAngles(level.scene, level.solution), 0);
}
