// 기록 모듈: 서버 SQLite 연동
//  - 게임이 끝날 때마다 plays에 기록 (이름 없이) → TOP 4에 들면 이름을 받아 추가
//  - 명예의 전당은 TOP 4만 (5위 아래는 자동으로 빠지지만 데이터 보기에는 남음)
//  - 서버에 닿지 않으면 마지막으로 받은 TOP 4를 브라우저(LocalStorage)에 보관해 보여 줌
export const TOP_N = 4;
export const NAME_MAX = 10;
const LS_KEY = 'chaos-tower-top';

async function api(method, url, body) {
  const r = await fetch(url, {
    method, cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const remember = (top) => { try { localStorage.setItem(LS_KEY, JSON.stringify(top)); } catch { /* 저장 공간 없음 */ } return top; };

export async function fetchTop() {
  try {
    return remember(await api('GET', '/api/leaderboard'));
  } catch {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
  }
}

// 게임 결과 저장 → { id, rank, qualifies }
export function savePlay(play) {
  return api('POST', '/api/plays', play);
}

// TOP 4에 든 기록에 이름 붙이기 → { id, rank, top }
export async function setName(id, name) {
  const res = await api('POST', `/api/plays/${id}/name`, { player_name: name.slice(0, NAME_MAX) });
  remember(res.top);
  return res;
}

// 데이터 보기: { total, named, avg_floor, best_floor, plays: [...] }
export function fetchPlays() {
  return api('GET', '/api/plays');
}

// 잘못된 기록 삭제 → { ok, top }
export async function deletePlay(id) {
  const res = await api('DELETE', `/api/plays/${id}`);
  remember(res.top);
  return res;
}
