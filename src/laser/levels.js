// 레이저 챌린지 레벨. 각 레벨은 "정답 각도(solution)"를 먼저 정하고, 타깃을 그 경로 위에 놓아서 만들었다
// → 반드시 풀 수 있고, tests/laser_unit.mjs 가 엔진으로 다시 검증한다.
//
// 손 거울(kind:'hand')은 위치가 고정이고, 손 기울기가 각도가 된다 (SNAP도 단위로 끊어서 → 손 떨림에 강함).
//   왜 위치는 고정? 거울이 기울어져 있어서 위치가 조금만 틀려도 반사점이 2~3배 밀려 손 떨림으로는 풀 수 없게 됨
//   (테스트로 확인: 위치까지 손으로 맞추면 허용 오차 ±6px). 각도만 맞추게 하면 반사 법칙을 생각해서 푸는 퍼즐이 됨.
// 고정 거울(kind:'fixed')은 움직이지 않는다.
export const W = 1280, H = 720;
export const SNAP = 5;                       // 손 거울 각도 단위 (도)
export const COLORS = { red: '#ff4d6d', yellow: '#ffd23f', blue: '#4dabff' };
const HAND_LEN = 150, FIXED_LEN = 130;

const hand = (id, x, y, angle) => ({ id, kind: 'hand', x, y, len: HAND_LEN, angle });
const fixed = (id, x, y, angle) => ({ id, kind: 'fixed', x, y, len: FIXED_LEN, angle });
const target = (id, order, color, x, y, r = 40) => ({ id, order, color, x, y, r });

export const LEVELS = [
  {
    id: 1, name: 'MISSION 01', title: '입사각 = 반사각', tutorial: true,
    desc: '손을 거울처럼 기울여 레이저를 타깃에 보내 보세요',
    timeLimit: 0, maxShots: 99, previewSegs: 4,
    solution: { H1: 25 },
    scene: {
      W, H, emitter: { x: 60, y: 360, angle: 0 },
      mirrors: [hand('H1', 360, 360, 90)],
      obstacles: [],
      targets: [target('T1', 0, 'red', 572, 107, 46)],
    },
  },
  {
    id: 2, name: 'MISSION 02', title: '두 손 거울', tutorial: false,
    desc: '두 손으로 두 개의 거울을 맞추세요', targetsText: '빨강 → 노랑 순서대로',
    timeLimit: 60, maxShots: 6, previewSegs: 3,
    solution: { H1: 20, H2: 20 },
    scene: {
      W, H, emitter: { x: 60, y: 540, angle: 0 },
      mirrors: [hand('H1', 320, 540, 90), hand('H2', 760, 171, 0)],
      obstacles: [{ x: 600, y: 380, w: 60, h: 340 }],
      targets: [target('T1', 0, 'red', 540, 355), target('T2', 1, 'yellow', 1000, 171)],
    },
  },
  {
    id: 3, name: 'MISSION 03', title: '순서대로 맞혀라', tutorial: false,
    desc: '빨강 → 노랑 → 파랑 순서로 세 타깃을 모두 활성화하세요', targetsText: '빨강 → 노랑 → 파랑 순서대로',
    timeLimit: 45, maxShots: 5, previewSegs: 2,
    solution: { H1: 20, H2: 135 },
    scene: {
      W, H, emitter: { x: 60, y: 360, angle: 0 },
      mirrors: [hand('H1', 380, 360, 90), hand('H2', 900, 142, 0), fixed('F1', 640, 142, 20), fixed('F2', 900, 520, 45)],
      obstacles: [{ x: 570, y: 270, w: 40, h: 450 }],
      targets: [target('T1', 0, 'red', 510, 251), target('T2', 1, 'yellow', 770, 142), target('T3', 2, 'blue', 900, 316)],
    },
  },
];

export const levelById = (id) => LEVELS.find((l) => l.id === id);
export const cloneScene = (s) => JSON.parse(JSON.stringify(s));
/** 각도를 SNAP 단위로 (0 ≤ a < 180) */
export const snapAngle = (a) => ((Math.round(a / SNAP) * SNAP) % 180 + 180) % 180;
