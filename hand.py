"""손 인식: 오르벡 컬러 + 정렬된 깊이 → MediaPipe 손 관절 21점 → 게임 입력 (화면 위치, 깊이, 쥠/폄).

별도 스레드에서 새 카메라 프레임마다 손을 찾고, 결과는 state()로 가져간다.
  nx, ny : 손 움직임 상자(config hand.box) 안의 위치, -1..1 (가운데 0, 오른쪽·위가 +)
  d      : 손바닥까지 거리 (m)
  grab   : 주먹을 쥐었는지 (손가락 펴짐 비율 + 히스테리시스)
레이저 챌린지용으로 보이는 모든 손(최대 2)을 화면 왼쪽부터 hands 목록에도 담는다:
  hands[i] = {nx, ny, d, ang, open, fist}   ang: 손가락이 가리키는 선의 기울기 (도, 0~180, 반시계 +, 화면에 보이는 대로)
"""
import os
import threading
import time
from collections import deque

import cv2
import numpy as np

from camera import OrbbecCamera, WebcamCamera, depth_at

PALM = (0, 5, 9, 13, 17)                           # 손바닥 중심 = 손목 + 손가락 뿌리 평균
FINGERS = ((5, 8), (9, 12), (13, 16), (17, 20))    # 검지~새끼 (뿌리, 끝)
BONES = ((0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
         (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20))
FOLLOW_PX = 100        # 직전 손 위치에서 이 거리(px) 안의 손을 계속 따라감
WRIST, MIDDLE_MCP = 0, 9                           # 손 기울기 = 손목 → 가운뎃손가락 뿌리 방향
LOST_RESET_S = 1.0     # 이만큼 손이 안 보이면 쥠 상태를 초기화
SWITCH_FRAMES = 2      # 쥠/폄이 바뀌려면 연속 프레임 수 (순간 오인식 무시)
FINGER_M = 0.10        # 손바닥 중심에서 손가락 끝까지 (m). 상자 위끝에서도 손가락이 카메라 안에 남게
FIT = 0.85             # 카메라에 보이는 범위 중 상자로 쓸 최대 비율


def finger_line_angle(x0, y0, x1, y1, mirror=True):
    """손목(x0,y0) → 가운뎃손가락 뿌리(x1,y1) 방향의 기울기. 이미지 픽셀 좌표(y 아래) → 화면에 보이는 각도(도).
    0~180 (선이라 방향은 무시), 반시계 +, 손가락이 위를 향하면 90°. mirror=True면 화면이 좌우 반전돼 보이므로 x를 뒤집음."""
    vx, vy = x1 - x0, y1 - y0
    if mirror:
        vx = -vx
    return float(np.degrees(np.arctan2(-vy, vx)) % 180.0)


class HandTracker:
    def __init__(self, cfg, root):
        cc, hc = cfg["camera"], cfg["hand"]
        self.cc, self.hc, self.root = cc, hc, root
        self.cam = OrbbecCamera(True, cc["width"], cc["height"])
        self.camera_kind = "orbbec"
        self._lock = threading.Lock()
        self._state = {"available": False, "visible": False, "seq": 0}
        self._jpeg = None
        self._preview_until = 0.0
        self._stop = threading.Event()
        self._thread = None
        self.delegate = "-"

    # ── 외부 인터페이스 ──
    def start(self):
        try:
            self.cam.open()
        except Exception as e:  # noqa: BLE001
            if not self.cc.get("webcam_fallback", True):
                raise
            print(f"[camera] 오르벡 카메라를 열 수 없습니다 ({e}) → 일반 웹캠으로 시도 (깊이 없음)", flush=True)
            self.cam.close()
            self.cam = WebcamCamera(self.cc["width"], self.cc["height"], self.cc.get("webcam_index", 0))
            self.cam.open()
            self.camera_kind = "webcam"
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def state(self):
        with self._lock:
            return dict(self._state)

    def preview_jpeg(self):
        """미리보기 영상 요청: 요청이 있는 동안(2초)만 관절을 그린 JPEG를 만든다."""
        self._preview_until = time.time() + 2.0
        with self._lock:
            return self._jpeg

    def close(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        self.cam.close()

    # ── 내부 ──
    def _landmarker(self):
        from mediapipe.tasks.python import BaseOptions, vision
        path = os.path.join(self.root, self.hc["model"])
        order = ["gpu", "cpu"] if self.hc.get("delegate", "gpu") == "gpu" else ["cpu"]
        for name in order:
            try:
                delegate = BaseOptions.Delegate.GPU if name == "gpu" else BaseOptions.Delegate.CPU
                opts = vision.HandLandmarkerOptions(
                    base_options=BaseOptions(model_asset_path=path, delegate=delegate),
                    running_mode=vision.RunningMode.VIDEO, num_hands=self.hc.get("max_hands", 2),
                    min_hand_detection_confidence=0.5, min_hand_presence_confidence=0.5, min_tracking_confidence=0.5)
                lm = vision.HandLandmarker.create_from_options(opts)
                self.delegate = name
                print(f"[hand] MediaPipe 손 인식 시작 ({name.upper()})", flush=True)
                return lm
            except Exception as e:  # noqa: BLE001
                print(f"[hand] {name.upper()} 델리게이트 실패: {e}", flush=True)
        raise RuntimeError("MediaPipe 손 인식을 만들 수 없습니다")

    def _run(self):
        try:
            import mediapipe as mp
            lm = self._landmarker()
        except Exception as e:  # noqa: BLE001
            with self._lock:
                self._state = {"available": False, "visible": False, "seq": 0, "error": str(e)}
            return
        w, h = self.cc["width"], self.cc["height"]
        last_seq, last_ts, seq = 0, 0, 0
        grab, flip, prev_px, last_seen, last_d = False, 0, None, 0.0, self.hc["depth_ref"]
        slot_fist, slot_flip, slot_n = [False, False], [0, 0], 0       # 두 손 각각의 쥠 상태 (화면 왼쪽 손 = 0)
        times = deque(maxlen=30)
        while not self._stop.is_set():
            f = self.cam.latest()
            if f is None or f[0] == last_seq:
                time.sleep(0.003)
                continue
            last_seq, t, bgr, depth = f
            ts = max(last_ts + 1, int(t * 1000))     # VIDEO 모드는 시각이 계속 늘어나야 함
            last_ts = ts
            res = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)), ts)
            times.append(time.time())
            cands = self._candidates(res, depth, w, h)
            hand = self._pick(cands, prev_px)
            now = time.time()
            st = {"available": True, "visible": hand is not None, "delegate": self.delegate,
                  "fps": round((len(times) - 1) / max(1e-3, times[-1] - times[0]), 1) if len(times) > 1 else 0.0,
                  "depth_ref": self.hc["depth_ref"], "depth_range": self.hc["depth_range"],
                  "menu_gain": self.hc.get("menu_gain", 1.0), "error": self.cam.error,
                  "camera": self.camera_kind, "mirror": self.cc.get("mirror", True)}
            if hand is not None:
                px, py, d_mm, openness = hand["px"], hand["py"], hand["d_mm"], hand["open"]
                prev_px, last_seen = (px, py), now
                d = d_mm / 1000 if d_mm else last_d
                last_d = d
                # 쥠/폄: 경계값 사이에서는 유지, 바뀌려면 SWITCH_FRAMES 연속
                want = (openness < self.hc["grab_close"]) if not grab else not (openness > self.hc["grab_open"])
                flip = flip + 1 if want != grab else 0
                if flip >= SWITCH_FRAMES:
                    grab, flip = want, 0
                nx, ny = self._to_box(px, py, d)
                st.update(nx=round(nx, 4), ny=round(ny, 4), d=round(d, 4), grab=grab, open=round(openness, 3),
                          px=round(px / w, 4), py=round(py / h, 4))
            elif now - last_seen > LOST_RESET_S:
                grab, flip, prev_px = False, 0, None
            # 보이는 모든 손 (화면 왼쪽부터). 쥠은 손마다 따로 (히스테리시스 + 연속 프레임)
            hl = []
            for c in cands:
                d = c["d_mm"] / 1000 if c["d_mm"] else last_d
                nx, ny = self._to_box(c["px"], c["py"], d)
                hl.append({"nx": nx, "ny": ny, "d": d, "ang": c["ang"], "open": c["open"]})
            hl.sort(key=lambda x: x["nx"])
            if len(hl) != slot_n:                                        # 손 수가 바뀌면 상태를 새로 시작
                slot_n = len(hl)
                slot_fist = [h_["open"] < self.hc["grab_close"] for h_ in hl] + [False, False]
                slot_flip = [0, 0]
            for k, h_ in enumerate(hl):
                want = (h_["open"] < self.hc["grab_close"]) if not slot_fist[k] else not (h_["open"] > self.hc["grab_open"])
                slot_flip[k] = slot_flip[k] + 1 if want != slot_fist[k] else 0
                if slot_flip[k] >= SWITCH_FRAMES:
                    slot_fist[k], slot_flip[k] = want, 0
                h_["fist"] = slot_fist[k]
            st["hands"] = [{"nx": round(h_["nx"], 4), "ny": round(h_["ny"], 4), "d": round(h_["d"], 3),
                            "ang": round(h_["ang"], 1), "open": round(h_["open"], 3), "fist": h_["fist"]} for h_ in hl]
            seq += 1
            st["seq"] = seq
            jpeg = self._draw(bgr, res, hand, grab, last_d) if now < self._preview_until else None
            with self._lock:
                self._state = st
                if jpeg is not None:
                    self._jpeg = jpeg
        lm.close()

    def _candidates(self, res, depth, w, h):
        """보이는 모든 손: 손바닥 중심(px), 거리, 손가락 펴짐, 손 기울기(도)."""
        cands = []
        mirror = self.cc.get("mirror", True)
        for i, lms in enumerate(res.hand_landmarks):
            px = float(np.mean([lms[j].x for j in PALM])) * w
            py = float(np.mean([lms[j].y for j in PALM])) * h
            d_mm = depth_at(depth, px, py, r=6)
            if d_mm is None:      # 손바닥 중심에 깊이가 없으면 손가락 뿌리들에서
                vals = [v for j in PALM if (v := depth_at(depth, lms[j].x * w, lms[j].y * h, r=4))]
                d_mm = float(np.median(vals)) if vals else None
            wl = res.hand_world_landmarks[i]
            P = np.array([[p.x, p.y, p.z] for p in wl])
            ratios = [np.linalg.norm(P[tip] - P[0]) / max(1e-6, np.linalg.norm(P[mcp] - P[0])) for mcp, tip in FINGERS]
            ang = finger_line_angle(lms[WRIST].x * w, lms[WRIST].y * h, lms[MIDDLE_MCP].x * w, lms[MIDDLE_MCP].y * h, mirror)
            cands.append({"i": i, "px": px, "py": py, "d_mm": d_mm, "open": float(np.mean(ratios)), "ang": ang})
        return cands

    def _pick(self, cands, prev_px):
        """보이는 손들 중 하나: 따라가던 손(가까이 있으면) → 없으면 카메라에 가장 가까운 손."""
        if not cands:
            return None
        if prev_px is not None:
            near = min(cands, key=lambda c: (c["px"] - prev_px[0]) ** 2 + (c["py"] - prev_px[1]) ** 2)
            if np.hypot(near["px"] - prev_px[0], near["py"] - prev_px[1]) < FOLLOW_PX:
                return near
        return min(cands, key=lambda c: c["d_mm"] or 1e9)

    def _box_at(self, d):
        """거리 d(m)에서 쓸 상자 반폭·반높이: 설정값, 단 카메라에 보이는 범위를 넘지 않게 (가까이 서면 줄어듦)."""
        b, w, h = self.hc["box"], self.cc["width"], self.cc["height"]
        vis_w = min(self.cam.cx, w - self.cam.cx) * d / self.cam.fx - abs(b["center_x"])
        vis_h = min(self.cam.cy, h - self.cam.cy) * d / self.cam.fy - abs(b["center_y"]) - FINGER_M
        return min(b["half_w"], FIT * vis_w), max(0.05, min(b["half_h"], FIT * vis_h))

    def _to_box(self, px, py, d):
        """픽셀 + 거리 → 카메라 기준 3D(m) → 손 움직임 상자 안 위치 (-1..1)."""
        b = self.hc["box"]
        hw, hh = self._box_at(d)
        X = (px - self.cam.cx) * d / self.cam.fx
        Y = (py - self.cam.cy) * d / self.cam.fy
        nx = (X - b["center_x"]) / hw
        ny = -(Y - b["center_y"]) / hh
        return (-nx if self.cc.get("mirror", True) else nx), ny

    def _draw(self, bgr, res, hand, grab, d):
        img = bgr.copy()
        w, h = img.shape[1], img.shape[0]
        # 지금 손 거리에서의 손 움직임 상자 (이 안에서 움직이면 화면 끝에서 끝)
        b = self.hc["box"]
        hw, hh = self._box_at(d)
        x0 = int(self.cam.cx + (b["center_x"] - hw) * self.cam.fx / d)
        x1 = int(self.cam.cx + (b["center_x"] + hw) * self.cam.fx / d)
        y0 = int(self.cam.cy + (b["center_y"] - hh) * self.cam.fy / d)
        y1 = int(self.cam.cy + (b["center_y"] + hh) * self.cam.fy / d)
        cv2.rectangle(img, (x0, y0), (x1, y1), (255, 212, 95), 1)
        for i, lms in enumerate(res.hand_landmarks):
            chosen = hand is not None and hand["i"] == i
            color = ((93, 255, 157) if grab else (255, 225, 134)) if chosen else (140, 140, 140)
            pts = [(int(p.x * w), int(p.y * h)) for p in lms]
            for a, c in BONES:
                cv2.line(img, pts[a], pts[c], color, 2)
        if hand is not None:
            cv2.circle(img, (int(hand["px"]), int(hand["py"])), 8, (93, 255, 157) if grab else (255, 225, 134), -1)
        mirror = self.cc.get("mirror", True)
        labels = []            # 손 기울기(도): 거울 각도로 쓰이는 값. 화면을 뒤집은 뒤에 써야 글자가 안 뒤집힘
        for lms in res.hand_landmarks:
            a = finger_line_angle(lms[WRIST].x * w, lms[WRIST].y * h, lms[MIDDLE_MCP].x * w, lms[MIDDLE_MCP].y * h, mirror)
            x = lms[WRIST].x * w
            labels.append((int(w - x if mirror else x), int(lms[WRIST].y * h), a))
        if self.cc.get("mirror", True):
            img = cv2.flip(img, 1)
        for lx, ly, a in labels:
            cv2.putText(img, f"{a:.0f}deg", (min(w - 70, max(4, lx - 30)), min(h - 8, ly + 26)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (80, 255, 255), 2)
        if hand is not None:
            d = f"{hand['d_mm'] / 1000:.2f}m" if hand["d_mm"] else "-"
            cv2.putText(img, f"{'GRAB' if grab else 'OPEN'} open={hand['open']:.2f} d={d}", (10, 24),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return buf.tobytes() if ok else None
