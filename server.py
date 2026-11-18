"""카오스 타워 · 레이저 챌린지 서버: 게임 파일 + 명예의 전당·게임 기록(SQLite) + 손 인식 스트림.

실행: .venv/bin/python server.py [--port 8001] [--no-camera]  →  http://<젯슨 IP>:8001
"""
import argparse
import csv
import datetime
import io
import json
import mimetypes
import os
import sqlite3
import time

import yaml
from flask import Flask, Response, abort, jsonify, request, send_from_directory

# 윈도우는 레지스트리 때문에 .js/.wasm 의 형식이 잘못 나올 수 있어서(모듈 스크립트·WASM이 안 열림) 직접 지정
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, "public")
SRC = os.path.join(ROOT, "src")
TESTS = os.path.join(ROOT, "tests")
DB_PATH = os.environ.get("CHAOS_DB") or os.path.join(ROOT, "data", "leaderboard.db")   # CHAOS_DB: 테스트용 임시 DB
NAME_MAX = 10
REASON_MAX = 40
TOP_N = 4               # 명예의 전당에 보이는 순위 수
LASER_TOP_N = 5         # 레이저 챌린지: 오늘의 챔피언 순위 수
EVENTS_MAX = 3000       # 레이저 챌린지: 한 판 이벤트 로그 최대 개수

app = Flask(__name__, static_folder=None)
tracker = None          # HandTracker (카메라가 없으면 None → 게임은 마우스로)
tracker_error = ""


def load_config():
    with open(os.path.join(ROOT, "config.yaml"), encoding="utf-8") as f:
        return yaml.safe_load(f)


def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


# DB (data/leaderboard.db, 파일이라 서버를 껐다 켜도 그대로)
#  plays       : 모든 게임 기록 (이름은 TOP 4에 들어 입력한 사람만). 데이터 보기에서 전부 보임
#  leaderboard : 명예의 전당 TOP 4. plays에서 다시 만들므로 5위 아래는 자동으로 빠짐 (plays에는 남음)
def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with connect() as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS leaderboard (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                player_name    VARCHAR(10) NOT NULL,
                max_floor      REAL        NOT NULL,
                failure_reason VARCHAR(40),
                created_at     TIMESTAMP   NOT NULL
            )""")
        con.execute("""
            CREATE TABLE IF NOT EXISTS plays (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                player_name    VARCHAR(10),
                max_floor      REAL        NOT NULL,
                best_time_s    REAL,
                collapses      INTEGER     NOT NULL DEFAULT 0,
                failure_reason VARCHAR(40),
                duration_s     REAL,
                created_at     TIMESTAMP   NOT NULL
            )""")
        # 레이저 챌린지: 한 판마다 한 줄 (이벤트 로그는 JSON). 카메라 영상은 저장하지 않음 — 거울 각도·발사 같은 게임 이벤트만
        con.execute("""
            CREATE TABLE IF NOT EXISTS laser_plays (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                player_name  VARCHAR(10),
                mission      INTEGER     NOT NULL,
                score        INTEGER     NOT NULL,
                targets      INTEGER     NOT NULL DEFAULT 0,
                total_targets INTEGER    NOT NULL DEFAULT 0,
                shots        INTEGER     NOT NULL DEFAULT 0,
                time_left    REAL,
                stars        INTEGER     NOT NULL DEFAULT 0,
                cleared      INTEGER     NOT NULL DEFAULT 0,
                input_source VARCHAR(10),
                events       TEXT,
                created_at   TIMESTAMP   NOT NULL
            )""")
        # 예전 방식(leaderboard에만 저장)의 기록이 plays에 없으면 옮겨 둠
        if con.execute("SELECT COUNT(*) FROM plays").fetchone()[0] == 0:
            con.execute("""INSERT INTO plays (player_name, max_floor, failure_reason, created_at)
                           SELECT player_name, max_floor, failure_reason, created_at FROM leaderboard ORDER BY id""")
        refresh_leaderboard(con)


def refresh_leaderboard(con):
    """이름이 있는 기록 중 상위 TOP_N개로 leaderboard를 다시 채움 (id는 plays와 같음)."""
    con.execute("DELETE FROM leaderboard")
    con.execute("""INSERT INTO leaderboard (id, player_name, max_floor, failure_reason, created_at)
                   SELECT id, player_name, max_floor, failure_reason, created_at FROM plays
                   WHERE player_name IS NOT NULL ORDER BY max_floor DESC, id ASC LIMIT ?""", (TOP_N,))


def top_rows(con):
    return [dict(r) for r in con.execute("SELECT * FROM leaderboard ORDER BY max_floor DESC, id ASC")]


def rank_of(con, floor, play_id):
    """이름이 있는 기록들 사이에서 이 층수의 순위 (같은 층이면 먼저 한 사람이 위)."""
    return con.execute("""SELECT COUNT(*) FROM plays WHERE player_name IS NOT NULL AND id != ?
                          AND (max_floor > ? OR (max_floor = ? AND id < ?))""",
                       (play_id, floor, floor, play_id)).fetchone()[0] + 1


def clean_name(v):
    name = str(v or "").strip()[:NAME_MAX]
    if not name:
        abort(400, "이름이 비어 있습니다")
    return name


def now_str():
    return datetime.datetime.now().isoformat(sep=" ", timespec="seconds")


# ── 정적 파일 (개발 중 수정이 바로 보이도록 캐시하지 않음) ──
@app.get("/")
def index():
    return send_from_directory(PUBLIC, "index.html", max_age=0)


@app.get("/laser")
def laser_page():
    return send_from_directory(PUBLIC, "laser.html", max_age=0)


@app.get("/src/<path:path>")
def src(path):
    return send_from_directory(SRC, path, max_age=0)


@app.get("/models/<path:path>")
def models(path):
    # 브라우저 손 인식이 모델을 여기서 받아 감 (없으면 인터넷에서)
    return send_from_directory(os.path.join(ROOT, "models"), path, max_age=0)


@app.get("/tests/<path:path>")
def tests(path):
    return send_from_directory(TESTS, path, max_age=0)


@app.get("/<path:path>")
def public(path):
    return send_from_directory(PUBLIC, path, max_age=0)


# ── 명예의 전당 · 게임 기록 API ──
@app.get("/api/leaderboard")
def get_leaderboard():
    with connect() as con:
        return jsonify(top_rows(con))


@app.post("/api/plays")
def post_play():
    """게임이 끝날 때마다 기록 (이름 없이). TOP 4에 드는지 알려 줌 → 들면 이름을 받아 /name으로."""
    body = request.get_json(silent=True) or {}
    try:
        floor = round(float(body.get("max_floor")), 1)
    except (TypeError, ValueError):
        abort(400, "max_floor가 숫자가 아닙니다")
    if not 0 <= floor <= 1000:
        abort(400, "층수가 올바르지 않습니다")
    num = lambda k: round(float(body[k]), 1) if body.get(k) is not None else None  # noqa: E731
    reason = body.get("failure_reason")
    with connect() as con:
        cur = con.execute(
            """INSERT INTO plays (max_floor, best_time_s, collapses, failure_reason, duration_s, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (floor, num("best_time_s"), int(body.get("collapses") or 0),
             str(reason)[:REASON_MAX] if reason else None, num("duration_s"), now_str()))
        play_id = cur.lastrowid
        rank = rank_of(con, floor, play_id)
        return jsonify({"id": play_id, "rank": rank, "qualifies": floor > 0 and rank <= TOP_N})


@app.post("/api/plays/<int:play_id>/name")
def name_play(play_id):
    name = clean_name((request.get_json(silent=True) or {}).get("player_name"))
    with connect() as con:
        row = con.execute("SELECT max_floor FROM plays WHERE id = ?", (play_id,)).fetchone()
        if row is None:
            abort(404, "기록이 없습니다")
        con.execute("UPDATE plays SET player_name = ? WHERE id = ?", (name, play_id))
        refresh_leaderboard(con)
        return jsonify({"id": play_id, "rank": rank_of(con, row["max_floor"], play_id), "top": top_rows(con)})


@app.post("/api/leaderboard")
def post_leaderboard():
    """이름과 층수를 한 번에 기록 (예전 방식 호환)."""
    body = request.get_json(silent=True) or {}
    name = clean_name(body.get("player_name"))
    try:
        floor = round(float(body.get("max_floor")), 1)
    except (TypeError, ValueError):
        abort(400, "max_floor가 숫자가 아닙니다")
    reason = body.get("failure_reason")
    with connect() as con:
        cur = con.execute("INSERT INTO plays (player_name, max_floor, failure_reason, created_at) VALUES (?, ?, ?, ?)",
                          (name, floor, str(reason)[:REASON_MAX] if reason else None, now_str()))
        refresh_leaderboard(con)
        return jsonify({"id": cur.lastrowid, "rank": rank_of(con, floor, cur.lastrowid), "top": top_rows(con)})


@app.get("/api/plays")
def get_plays():
    """데이터 보기: 지금까지 모든 게임 (최근 것부터) + 요약."""
    with connect() as con:
        plays = [dict(r) for r in con.execute("SELECT * FROM plays ORDER BY id DESC")]
        ranks = {r["id"]: i + 1 for i, r in enumerate(top_rows(con))}
    for p in plays:
        p["rank"] = ranks.get(p["id"])
    floors = [p["max_floor"] for p in plays]
    return jsonify({
        "total": len(plays),
        "named": sum(1 for p in plays if p["player_name"]),
        "avg_floor": round(sum(floors) / len(floors), 2) if floors else 0,
        "best_floor": max(floors) if floors else 0,
        "plays": plays,
    })


@app.get("/api/plays.csv")
def plays_csv():
    with connect() as con:
        rows = con.execute("SELECT * FROM plays ORDER BY id").fetchall()
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["번호", "이름", "최고 층", "최고 층 도달(초)", "붕괴 횟수", "마지막 붕괴 원인", "게임 시간(초)", "플레이 시각"])
    for r in rows:
        w.writerow([r["id"], r["player_name"] or "", r["max_floor"], r["best_time_s"] if r["best_time_s"] is not None else "",
                    r["collapses"], r["failure_reason"] or "", r["duration_s"] if r["duration_s"] is not None else "",
                    r["created_at"]])
    return Response("\ufeff" + out.getvalue(), mimetype="text/csv",       # BOM: 엑셀에서 한글이 안 깨지게
                    headers={"Content-Disposition": "attachment; filename=chaos_tower_plays.csv"})


@app.delete("/api/plays/<int:play_id>")
def delete_play(play_id):
    """잘못된 기록 삭제 (데이터와 명예의 전당 모두에서). TOP 4가 비면 다음 기록이 올라옴."""
    with connect() as con:
        if con.execute("DELETE FROM plays WHERE id = ?", (play_id,)).rowcount == 0:
            abort(404, "기록이 없습니다")
        refresh_leaderboard(con)
        return jsonify({"ok": True, "top": top_rows(con)})


# ── 레이저 챌린지 기록 API ──
def today_str():
    return datetime.date.today().isoformat()


def laser_top(con, mission, day=None):
    """그날(기본 오늘) 이름이 있는 기록 중 점수 상위 LASER_TOP_N개."""
    day = day or today_str()
    return [dict(r) for r in con.execute(
        """SELECT id, player_name, score, targets, total_targets, shots, time_left, stars, cleared, created_at
           FROM laser_plays WHERE mission = ? AND player_name IS NOT NULL AND substr(created_at, 1, 10) = ?
           ORDER BY score DESC, id ASC LIMIT ?""", (mission, day, LASER_TOP_N))]


def laser_rank(con, mission, score, play_id):
    """오늘 이름이 있는 기록들 사이에서 이 점수의 순위 (같은 점수면 먼저 한 사람이 위)."""
    return con.execute(
        """SELECT COUNT(*) FROM laser_plays WHERE mission = ? AND player_name IS NOT NULL AND id != ?
           AND substr(created_at, 1, 10) = ? AND (score > ? OR (score = ? AND id < ?))""",
        (mission, play_id, today_str(), score, score, play_id)).fetchone()[0] + 1


@app.get("/api/laser/leaderboard")
def laser_leaderboard():
    mission = request.args.get("mission", 3, type=int)
    with connect() as con:
        return jsonify({"date": today_str(), "mission": mission, "top": laser_top(con, mission)})


@app.post("/api/laser/plays")
def laser_post_play():
    """한 판이 끝날 때마다 기록 (이름 없이). 오늘의 TOP에 드는지 알려 줌 → 들면 이름을 받아 /name으로."""
    b = request.get_json(silent=True) or {}
    try:
        mission, score = int(b.get("mission")), int(b.get("score"))
    except (TypeError, ValueError):
        abort(400, "mission/score가 숫자가 아닙니다")
    if not (0 <= score <= 100000 and 1 <= mission <= 20):
        abort(400, "값이 올바르지 않습니다")
    num = lambda k: round(float(b[k]), 1) if b.get(k) is not None else None  # noqa: E731
    events = b.get("events")
    events_json = json.dumps(events[:EVENTS_MAX], ensure_ascii=False, separators=(",", ":")) if isinstance(events, list) else None
    with connect() as con:
        cur = con.execute(
            """INSERT INTO laser_plays (mission, score, targets, total_targets, shots, time_left, stars, cleared,
                                         input_source, events, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (mission, score, int(b.get("targets") or 0), int(b.get("total_targets") or 0), int(b.get("shots") or 0),
             num("time_left"), int(b.get("stars") or 0), 1 if b.get("cleared") else 0,
             str(b.get("input_source") or "")[:10] or None, events_json, now_str()))
        pid = cur.lastrowid
        rank = laser_rank(con, mission, score, pid)
        return jsonify({"id": pid, "rank": rank, "qualifies": score > 0 and rank <= LASER_TOP_N})


@app.post("/api/laser/plays/<int:play_id>/name")
def laser_name_play(play_id):
    name = clean_name((request.get_json(silent=True) or {}).get("player_name"))
    with connect() as con:
        row = con.execute("SELECT mission, score FROM laser_plays WHERE id = ?", (play_id,)).fetchone()
        if row is None:
            abort(404, "기록이 없습니다")
        con.execute("UPDATE laser_plays SET player_name = ? WHERE id = ?", (name, play_id))
        return jsonify({"id": play_id, "rank": laser_rank(con, row["mission"], row["score"], play_id),
                        "top": laser_top(con, row["mission"])})


@app.get("/api/laser/plays")
def laser_get_plays():
    """데이터 보기: 모든 판 (최근 것부터, 이벤트 로그는 개수만) + 요약."""
    with connect() as con:
        rows = [dict(r) for r in con.execute(
            """SELECT id, player_name, mission, score, targets, total_targets, shots, time_left, stars, cleared,
                      input_source, created_at, events FROM laser_plays ORDER BY id DESC""")]
    for r in rows:
        try:
            r["event_count"] = len(json.loads(r.pop("events") or "[]"))
        except ValueError:
            r["event_count"] = 0
    return jsonify({"total": len(rows), "cleared": sum(r["cleared"] for r in rows),
                    "best": max((r["score"] for r in rows), default=0), "plays": rows})


@app.get("/api/laser/plays/<int:play_id>")
def laser_get_play(play_id):
    with connect() as con:
        r = con.execute("SELECT * FROM laser_plays WHERE id = ?", (play_id,)).fetchone()
    if r is None:
        abort(404, "기록이 없습니다")
    d = dict(r)
    d["events"] = json.loads(d["events"] or "[]")
    return jsonify(d)


@app.get("/api/laser/plays.csv")
def laser_plays_csv():
    with connect() as con:
        rows = con.execute("SELECT * FROM laser_plays ORDER BY id").fetchall()
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["번호", "이름", "미션", "점수", "맞힌 타깃", "전체 타깃", "발사 수", "남은 시간(초)", "별", "클리어", "입력", "플레이 시각"])
    for r in rows:
        w.writerow([r["id"], r["player_name"] or "", r["mission"], r["score"], r["targets"], r["total_targets"], r["shots"],
                    r["time_left"] if r["time_left"] is not None else "", r["stars"], "O" if r["cleared"] else "",
                    r["input_source"] or "", r["created_at"]])
    return Response("\ufeff" + out.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=laser_challenge_plays.csv"})


@app.delete("/api/laser/plays/<int:play_id>")
def laser_delete_play(play_id):
    with connect() as con:
        if con.execute("DELETE FROM laser_plays WHERE id = ?", (play_id,)).rowcount == 0:
            abort(404, "기록이 없습니다")
        return jsonify({"ok": True})


@app.get("/api/health")
def health():
    return jsonify({"ok": True})


# ── 손 인식 ──
def hand_state():
    if tracker is None:
        return {"available": False, "visible": False, "seq": 0, "error": tracker_error}
    return tracker.state()


@app.get("/hand")
def hand_stream():
    """손 입력 스트림 (SSE): 새 결과가 나올 때마다 (카메라 약 30fps)."""
    def gen():
        last, last_sent = None, 0.0
        while True:
            st = hand_state()
            now = time.time()
            if st.get("seq") != last or now - last_sent > 1.0:
                last, last_sent = st.get("seq"), now
                yield f"data: {json.dumps(st)}\n\n"
            time.sleep(1 / 120)
    return Response(gen(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.get("/api/hand")
def api_hand():
    return jsonify(hand_state())


@app.get("/video")
def video():
    """손 인식 미리보기 (MJPEG): 관절, 손 움직임 상자, 쥠/폄. 위치 맞출 때 사용."""
    if tracker is None:
        abort(503, tracker_error or "카메라 없음")

    def gen():
        while True:
            jpg = tracker.preview_jpeg()
            if jpg:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
            time.sleep(1 / 15)
    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame")


def start_tracker(cfg):
    global tracker, tracker_error
    try:
        from hand import HandTracker
        t = HandTracker(cfg, ROOT)
        t.start()
        tracker = t
    except Exception as e:  # noqa: BLE001
        tracker_error = f"손 인식을 켜지 못했습니다: {e}"
        print(f"[hand] {tracker_error} → 마우스로 진행", flush=True)


if __name__ == "__main__":
    cfg = load_config()
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=cfg["server"]["port"])
    ap.add_argument("--no-camera", action="store_true", help="손 인식 없이 마우스로만")
    args = ap.parse_args()
    init_db()
    if cfg["camera"].get("enabled", True) and not args.no_camera:
        start_tracker(cfg)
    else:
        tracker_error = "카메라 꺼짐 (설정)"
    app.run(host=args.host, port=args.port, threaded=True)
