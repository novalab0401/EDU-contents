"""hands 목록(두 손 · 기울기 각도 · 손별 쥠) 검증. 실제 카메라·손 모델 없이, 가짜 카메라와 가짜 인식기를 꽂아서
HandTracker의 실제 _run 루프를 돌린다.   실행: python tests/hand_hands_test.py   (프로젝트 폴더에서, 설치된 파이썬으로)"""
import math
import os
import sys
import time
from types import SimpleNamespace as NS

import numpy as np
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import hand as H  # noqa: E402

fail = 0


def check(cond, name, extra=""):
    global fail
    print(("  ✓ " if cond else "  ✗ ") + name + ("" if cond else f"  {extra}"))
    fail += 0 if cond else 1


# ── 순수 함수: 손목 → 가운뎃손가락 방향 → 화면 각도 ──
print("1. finger_line_angle")
f = H.finger_line_angle
check(abs(f(100, 200, 100, 100, True) - 90) < 1e-9, "손가락이 위를 향하면 90°")
check(abs(f(100, 200, 100 + 100, 200 - 100, True) - 135) < 1e-9, "미러 화면: 이미지 오른쪽 위 → 화면에서는 왼쪽으로 기울어 보임 (135°)")
check(abs(f(100, 200, 100 + 100, 200 - 100, False) - 45) < 1e-9, "미러 아님: 오른쪽 위 = 45°")
check(abs(f(100, 200, 100 - 100, 200 - 100, True) - 45) < 1e-9, "미러 화면: 이미지 왼쪽 위 → 화면 오른쪽으로 기울어 보임 (45°)")
check(abs(f(100, 100, 100, 200, True) - 90) < 1e-9, "손가락이 아래를 향해도 선이라서 90° (180° 주기)")
check(abs(f(100, 200, 200, 200, False) - 0) < 1e-9 or abs(f(100, 200, 200, 200, False) - 180) < 1e-9, "수평 = 0°")

# ── 가짜 카메라 / 가짜 인식기 ──
W, Hh = 640, 360


def hand_lms(cx, cy, angle_deg, ratio):
    """이미지 정규 좌표 21점 + 월드 좌표 21점. 손목(0)은 (cx,cy), 손가락은 angle 방향 (이미지에서 위=90°)."""
    ux, uy = math.cos(math.radians(angle_deg)), -math.sin(math.radians(angle_deg))     # 이미지 좌표 (y 아래)
    img, world = [], []
    for j in range(21):
        if j == 0:
            L = 0.0
        elif j in (5, 9, 13, 17):
            L = 0.12
        else:
            L = 0.12 + 0.03 * ((j - 1) % 4)
        img.append(NS(x=cx + ux * L * (Hh / W) * 1.0, y=cy + uy * L, z=0))
        base = 0.09 if j in (5, 9, 13, 17) else (0.09 * ratio if j in (8, 12, 16, 20) else 0.05)
        world.append(NS(x=ux * (0 if j == 0 else base), y=uy * (0 if j == 0 else base), z=0))
    return img, world


class FakeCam:
    cx, cy, fx, fy = W / 2, Hh / 2, 460.0, 460.0
    error = ""

    def __init__(self):
        self.seq = 0

    def open(self): pass
    def close(self): pass

    def latest(self):
        self.seq += 1
        time.sleep(0.004)
        return (self.seq, time.time(), np.zeros((Hh, W, 3), np.uint8), None)


class FakeLM:
    def __init__(self, script):
        self.script, self.n = script, 0

    def detect_for_video(self, image, ts):
        self.n += 1
        hands = self.script(self.n)
        lms = [hand_lms(*h) for h in hands]
        return NS(hand_landmarks=[a for a, _ in lms], hand_world_landmarks=[b for _, b in lms])

    def close(self): pass


def run_tracker(script, frames=40):
    cfg = yaml.safe_load(open(os.path.join(ROOT, "config.yaml"), encoding="utf-8"))
    t = H.HandTracker(cfg, ROOT)
    t.cam = FakeCam()
    t._landmarker = lambda: FakeLM(script)
    t._thread = __import__("threading").Thread(target=t._run, daemon=True)
    t._thread.start()
    deadline = time.time() + 5
    last = None
    while time.time() < deadline:
        st = t.state()
        last = st
        if st.get("seq", 0) >= frames:
            break
        time.sleep(0.01)
    t._stop.set()
    t._thread.join(timeout=2)
    return last, t


print("2. 두 손: 화면 왼쪽부터 정렬 · 손마다 각도")
# 이미지에서 x=0.30(카메라 기준 왼쪽) 손은 미러 화면에서는 오른쪽, x=0.70 손은 화면 왼쪽
st, _ = run_tracker(lambda n: [(0.30, 0.75, 60, 1.9), (0.70, 0.75, 120, 1.9)])
hs = st.get("hands", [])
check(len(hs) == 2, "손 2개", str(hs))
check(len(hs) == 2 and hs[0]["nx"] < hs[1]["nx"], "화면 왼쪽 손이 hands[0]", str([h["nx"] for h in hs]))
# 이미지 x=0.70 손은 이미지에서 120° 방향(왼쪽 위로 기울어짐) → 미러 화면에서는 오른쪽 위(60°)로 보임
check(len(hs) == 2 and abs(hs[0]["ang"] - 60) < 3, "화면 왼쪽 손 각도 ≈ 60° (이미지 120°를 거울로 본 값)", str(hs[:1]))
check(len(hs) == 2 and abs(hs[1]["ang"] - 120) < 3, "화면 오른쪽 손 각도 ≈ 120°", str(hs[1:]))
check(not any(h["fist"] for h in hs), "편 손은 fist=False", str(hs))
check(st.get("visible") is True and "nx" in st, "기존 단일 손 필드(nx, grab …)는 그대로 유지")

print("3. 손별 쥠 (주먹) 감지 · 연속 프레임 디바운스")
# 오른쪽(이미지 x=0.30) 손만 20프레임부터 주먹 (open ratio 1.0)
st, _ = run_tracker(lambda n: [(0.30, 0.75, 60, 1.9 if n < 20 else 1.0), (0.70, 0.75, 120, 1.9)], frames=45)
hs = st["hands"]
check(len(hs) == 2 and hs[1]["fist"] and not hs[0]["fist"], "화면 오른쪽 손만 주먹", str(hs))

print("4. 손이 하나만 보일 때 · 없을 때")
st, _ = run_tracker(lambda n: [(0.50, 0.75, 90, 1.9)], frames=20)
check(len(st["hands"]) == 1 and abs(st["hands"][0]["ang"] - 90) < 3 and abs(st["hands"][0]["nx"]) < 0.2, "한 손: 90°, 가운데", str(st["hands"]))
st, _ = run_tracker(lambda n: [], frames=15)
check(st["hands"] == [] and st["visible"] is False, "손이 없으면 hands=[]")

print("5. 손이 2개 → 1개로 바뀔 때 가짜 주먹이 생기지 않음")
st, _ = run_tracker(lambda n: [(0.30, 0.75, 60, 1.9), (0.70, 0.75, 120, 1.9)] if n < 20 else [(0.70, 0.75, 120, 1.9)], frames=40)
check(len(st["hands"]) == 1 and not st["hands"][0]["fist"], "손 수가 바뀌어도 편 손은 편 손", str(st["hands"]))

print("\nFAILED" if fail else "\nall passed")
sys.exit(1 if fail else 0)
