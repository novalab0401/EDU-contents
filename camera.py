"""Orbbec Gemini 335: 컬러(BGR) + 컬러에 정렬된 깊이(mm). 별도 스레드로 계속 받아 최신 프레임만 보관.
(~/action-text/camera.py에서 가져옴. 3D 좌표 계산용 광학 중심 cx, cy 추가)"""
import threading
import time

import cv2
import numpy as np


class OrbbecCamera:
    def __init__(self, use_depth=True, width=640, height=360):
        self.use_depth, self.size = use_depth, (width, height)
        self.pipe = None
        self.align = None          # 소프트웨어 정렬 필터 (하드웨어 정렬이 안 될 때만)
        self.fx = self.fy = None
        self.cx, self.cy = width / 2, height / 2
        self._lock = threading.Lock()
        self._frame = None          # (seq, t, bgr, depth)
        self._seq = 0
        self._stop = threading.Event()
        self._thread = None
        self.error = ""

    def open(self):
        from pyorbbecsdk import AlignFilter, Config, OBAlignMode, OBFormat, OBSensorType, OBStreamType, Pipeline
        self.pipe = Pipeline()
        conf = Config()
        # BGR 무압축 → JPEG 디코딩 불필요. 깊이는 카메라 하드웨어가 컬러에 정렬 (CPU 거의 안 씀)
        cp = self.pipe.get_stream_profile_list(OBSensorType.COLOR_SENSOR).get_video_stream_profile(*self.size, OBFormat.BGR, 30)
        conf.enable_stream(cp)
        if self.use_depth:
            dp = None
            try:
                dl = self.pipe.get_d2c_depth_profile_list(cp, OBAlignMode.HW_MODE)
                for i in range(dl.get_count()):
                    p = dl.get_stream_profile_by_index(i).as_video_stream_profile()
                    if p.get_fps() == 30 and p.get_format() == OBFormat.Y16:
                        dp = p
                        break
            except Exception:  # noqa: BLE001
                dp = None
            if dp is not None:
                conf.enable_stream(dp)
                conf.set_align_mode(OBAlignMode.HW_MODE)
            else:
                conf.enable_stream(self.pipe.get_stream_profile_list(OBSensorType.DEPTH_SENSOR).get_default_video_stream_profile())
                self.align = AlignFilter(align_to_stream=OBStreamType.COLOR_STREAM)
        self.pipe.start(conf)
        try:
            k = self.pipe.get_camera_param().rgb_intrinsic
            self.fx, self.fy, self.cx, self.cy = float(k.fx), float(k.fy), float(k.cx), float(k.cy)
            if k.width and k.width != self.size[0]:      # 다른 해상도 기준 값이면 비율 보정
                s = self.size[0] / k.width
                self.fx, self.fy, self.cx, self.cy = self.fx * s, self.fy * s, self.cx * s, self.cy * s
        except Exception:  # noqa: BLE001
            self.fx = self.fy = 692.0 * self.size[0] / 1280   # Gemini 335 실측값 (1280 기준 692)
        print(f"[camera] {self.size[0]}x{self.size[1]} BGR, depth={'off' if not self.use_depth else ('SW 정렬' if self.align else 'HW 정렬')}, fy={self.fy:.0f}", flush=True)
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _color_to_bgr(self, f):
        from pyorbbecsdk import OBFormat
        w, h, fmt = f.get_width(), f.get_height(), f.get_format()
        data = np.asanyarray(f.get_data())
        if fmt == OBFormat.MJPG:
            return cv2.imdecode(data, cv2.IMREAD_COLOR)
        if fmt == OBFormat.RGB:
            return cv2.cvtColor(data.reshape(h, w, 3), cv2.COLOR_RGB2BGR)
        if fmt == OBFormat.BGR:
            return data.reshape(h, w, 3)
        if fmt == OBFormat.YUYV:
            return cv2.cvtColor(data.reshape(h, w, 2), cv2.COLOR_YUV2BGR_YUYV)
        return None

    def _grab(self):
        # 시작 직후엔 컬러/깊이 짝이 안 맞아 정렬이 None을 줄 수 있으므로 None을 돌려주고 건너뜀
        frames = self.pipe.wait_for_frames(1000)
        if frames is None:
            return None
        if self.align is not None:
            frames = self.align.process(frames)
            if frames is None:
                return None
            frames = frames.as_frame_set()
        cf = frames.get_color_frame()
        if cf is None:
            return None
        bgr = self._color_to_bgr(cf)
        if bgr is None:
            return None
        depth = None
        if self.use_depth:
            df = frames.get_depth_frame()
            if df is not None:
                d = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(df.get_height(), df.get_width())
                depth = d.astype(np.float32) * df.get_depth_scale()
                if depth.shape[:2] != bgr.shape[:2]:
                    depth = cv2.resize(depth, (bgr.shape[1], bgr.shape[0]), interpolation=cv2.INTER_NEAREST)
        return bgr, depth

    def _run(self):
        last_ok = time.time()
        while not self._stop.is_set():
            try:
                got = self._grab()
            except Exception as e:  # noqa: BLE001
                self.error, got = str(e), None
            if got is None:
                if time.time() - last_ok > 3:
                    self.error = "카메라 프레임이 3초 이상 없음"
                continue
            last_ok, self.error = time.time(), ""
            with self._lock:
                self._seq += 1
                self._frame = (self._seq, last_ok, got[0], got[1])

    def latest(self):
        with self._lock:
            return self._frame

    def close(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        if self.pipe is not None:
            try:
                self.pipe.stop()
            except Exception:  # noqa: BLE001
                pass
            self.pipe = None


class WebcamCamera:
    """일반 웹캠 (깊이 없음). 오르벡 카메라를 못 열 때의 대체 — 노트북 내장 카메라로 테스트하거나 예비로 쓸 때.
    OrbbecCamera와 같은 인터페이스 (open/latest/close, fx fy cx cy, error). 깊이가 없으니 손 거리는 설정값(depth_ref)으로 고정."""

    def __init__(self, width=640, height=360, index=0):
        self.size, self.index = (width, height), index
        self.fx = self.fy = 0.72 * width               # 가로 시야각 약 70°로 가정
        self.cx, self.cy = width / 2, height / 2
        self._lock = threading.Lock()
        self._frame = None
        self._seq = 0
        self._stop = threading.Event()
        self._thread = None
        self._cap = None
        self.error = ""

    def open(self):
        import sys
        backend = cv2.CAP_DSHOW if sys.platform.startswith("win") else cv2.CAP_ANY
        cap = cv2.VideoCapture(self.index, backend)
        if not cap.isOpened():
            cap.release()
            raise RuntimeError(f"웹캠({self.index})을 열 수 없습니다")
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        self._cap = cap
        print(f"[camera] 웹캠 {self.index} (깊이 없음) → {self.size[0]}x{self.size[1]}", flush=True)
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        w, h = self.size
        last_ok = time.time()
        while not self._stop.is_set():
            ok, frame = self._cap.read()
            if not ok or frame is None:
                if time.time() - last_ok > 3:
                    self.error = "웹캠 프레임이 3초 이상 없음"
                time.sleep(0.01)
                continue
            fh, fw = frame.shape[:2]
            want_h = int(round(fw * h / w))               # 가운데를 설정 비율(16:9)로 잘라 냄
            if want_h < fh:
                y0 = (fh - want_h) // 2
                frame = frame[y0:y0 + want_h]
            frame = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
            last_ok, self.error = time.time(), ""
            with self._lock:
                self._seq += 1
                self._frame = (self._seq, last_ok, frame, None)

    def latest(self):
        with self._lock:
            return self._frame

    def close(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        if self._cap is not None:
            self._cap.release()
            self._cap = None


def depth_at(depth, x, y, r=7):
    """(x, y) 주변 (2r+1)^2 영역의 0이 아닌 깊이 중앙값(mm). 없으면 None."""
    if depth is None:
        return None
    h, w = depth.shape[:2]
    x, y = int(round(x)), int(round(y))
    if not (0 <= x < w and 0 <= y < h):
        return None
    patch = depth[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1]
    v = patch[patch > 0]
    return float(np.median(v)) if v.size else None
