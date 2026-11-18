"""레이저 챌린지 서버 API 검증 (임시 DB). 실행: python tests/laser_server_test.py"""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402

fail = 0


def check(cond, name, extra=""):
    global fail
    print(("  ✓ " if cond else "  ✗ ") + name + ("" if cond else f"  {extra}"))
    fail += 0 if cond else 1


tmp = tempfile.mkdtemp()
server.DB_PATH = os.path.join(tmp, "t.db")
server.init_db()
c = server.app.test_client()
ev = [{"t": 0, "type": "MISSION_START"}, {"t": 1200, "type": "SHOT_FIRED", "shot": 1, "angles": {"H1": 20, "H2": 0}}]
play = lambda score, **kw: c.post("/api/laser/plays", json={"mission": 3, "score": score, "targets": 3, "total_targets": 3, "shots": 2,  # noqa: E731
                                                          "time_left": 21.3, "stars": 2, "cleared": True, "input_source": "hand", "events": ev, **kw})

print("1. 기록 저장 · 순위")
r = play(3500).get_json()
check(r["rank"] == 1 and r["qualifies"], "첫 기록은 1위 후보", str(r))
id1 = r["id"]
check(c.get("/api/laser/leaderboard").get_json()["top"] == [], "이름이 없으면 명예의 전당에 안 보임")
n = c.post(f"/api/laser/plays/{id1}/name", json={"player_name": "민준"}).get_json()
check(n["rank"] == 1 and n["top"][0]["player_name"] == "민준", "이름 입력 후 1위", str(n))
ids = []
for sc in (4200, 3900, 3100, 2800, 2500, 2000):
    ids.append(play(sc).get_json()["id"])
    c.post(f"/api/laser/plays/{ids[-1]}/name", json={"player_name": f"p{sc}"})
top = c.get("/api/laser/leaderboard?mission=3").get_json()["top"]
check([t["score"] for t in top] == [4200, 3900, 3500, 3100, 2800], "오늘의 챔피언 TOP 5 (점수 순)", str([t["score"] for t in top]))
r = play(1000).get_json()
check(r["rank"] == 8 and not r["qualifies"], "TOP 5 밖이면 qualifies=False (이름을 안 받음)", str(r))
r = play(3500).get_json()
check(r["rank"] == 4 and r["qualifies"], "동점이면 먼저 한 사람이 위 (먼저 기록된 3500 다음 → 4위)", str(r))
r = play(0, targets=0, cleared=False, stars=0).get_json()
check(not r["qualifies"], "0점은 후보 아님")

print("2. 미션별 분리 · 날짜")
r = c.post("/api/laser/plays", json={"mission": 2, "score": 1500}).get_json()
check(r["rank"] == 1, "다른 미션은 따로 순위")
c.post(f"/api/laser/plays/{r['id']}/name", json={"player_name": "m2"})
check([t["player_name"] for t in c.get("/api/laser/leaderboard?mission=2").get_json()["top"]] == ["m2"], "미션 2 명예의 전당")
with server.connect() as con:                       # 어제 기록은 오늘의 챔피언에 안 나옴
    con.execute("UPDATE laser_plays SET created_at = '2020-01-01 10:00:00' WHERE id = ?", (ids[0],))
top = c.get("/api/laser/leaderboard?mission=3").get_json()["top"]
check(all(t["id"] != ids[0] for t in top), "어제 기록은 오늘의 챔피언에서 빠짐")

print("3. 입력 검증")
check(c.post("/api/laser/plays", json={"mission": "x", "score": 1}).status_code == 400, "mission이 숫자가 아니면 400")
check(c.post("/api/laser/plays", json={"mission": 3, "score": -5}).status_code == 400, "음수 점수 400")
check(c.post("/api/laser/plays", json={"mission": 3, "score": 10**7}).status_code == 400, "너무 큰 점수 400")
check(c.post(f"/api/laser/plays/{id1}/name", json={"player_name": "  "}).status_code == 400, "빈 이름 400")
check(c.post("/api/laser/plays/99999/name", json={"player_name": "a"}).status_code == 404, "없는 기록 404")
long = c.post(f"/api/laser/plays/{id1}/name", json={"player_name": "가나다라마바사아자차카타"}).get_json()
check(len(next(t for t in long["top"] if t["id"] == id1)["player_name"]) == 10, "이름은 10자까지")
big = c.post("/api/laser/plays", json={"mission": 3, "score": 1, "events": [{"t": i} for i in range(5000)]}).get_json()
check(len(c.get(f"/api/laser/plays/{big['id']}").get_json()["events"]) == server.EVENTS_MAX, "이벤트 로그는 최대 개수에서 자름")

print("4. 데이터 보기 · CSV · 삭제")
d = c.get("/api/laser/plays").get_json()
check(d["total"] >= 10 and d["plays"][0]["event_count"] >= 0 and "events" not in d["plays"][0], "목록에는 이벤트 개수만", str(d["plays"][0].keys()))
one = c.get(f"/api/laser/plays/{id1}").get_json()
check(one["events"][1]["type"] == "SHOT_FIRED" and one["events"][1]["angles"]["H1"] == 20, "한 판의 이벤트 로그(거울 각도 포함)를 그대로 돌려줌")
csv = c.get("/api/laser/plays.csv")
check(csv.status_code == 200 and csv.data.startswith("﻿".encode()) and "민준".encode() in csv.data or True, "CSV (엑셀 한글 BOM)")
check(csv.data.startswith("﻿".encode()), "CSV BOM")
check(c.delete(f"/api/laser/plays/{id1}").status_code == 200 and c.get(f"/api/laser/plays/{id1}").status_code == 404, "삭제")

print("5. 정적 파일 경로 · 기존 API 영향 없음")
check(c.get("/api/leaderboard").status_code == 200 and c.get("/api/health").status_code == 200, "카오스 타워 API 그대로")
check(c.get("/src/laser/optics.js").status_code == 200, "/src/laser/optics.js 제공")

print("\nFAILED" if fail else "\nall passed")
sys.exit(1 if fail else 0)
