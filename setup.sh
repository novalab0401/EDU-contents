#!/bin/bash
# 설치: 파이썬 가상환경(.venv) + 패키지 + 손 인식 모델. 사용법: ./setup.sh   (다른 파이썬: PYTHON=python3.11 ./setup.sh)
set -e
cd "$(dirname "$0")"
PY=${PYTHON:-python3}
$PY -c 'import sys; assert (3, 9) <= sys.version_info[:2] <= (3, 13), "Python 3.9~3.13이 필요합니다"'

if [ ! -x .venv/bin/python ]; then
  echo "[1/4] 가상환경 만들기 (.venv)"
  if ! $PY -m venv .venv >/dev/null 2>&1; then
    # python3-venv(ensurepip)가 없는 시스템(예: 젯슨): pip 없이 만들고 get-pip.py로 pip 설치
    rm -rf .venv
    $PY -m venv --without-pip .venv
    TMP=$(mktemp -d)
    curl -sSfL https://bootstrap.pypa.io/get-pip.py -o "$TMP/get-pip.py"
    .venv/bin/python -I "$TMP/get-pip.py" -q
    rm -rf "$TMP"
  fi
else
  echo "[1/4] 가상환경 있음 (.venv)"
fi

echo "[2/4] 패키지 설치 (처음엔 몇 분 걸림)"
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements.txt
echo "[3/4] 오르벡 카메라 SDK (pyorbbecsdk2, 의존성 없이)"
.venv/bin/python -m pip install -q --no-deps pyorbbecsdk2==2.1.2

echo "[4/4] 손 인식 모델"
mkdir -p models data
if [ ! -s models/hand_landmarker.task ]; then
  curl -sSfL -o models/hand_landmarker.task \
    https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task
fi

echo
echo "설치 완료. 실행: ./run.sh"
if [ "$(uname)" = "Linux" ] && [ ! -f /etc/udev/rules.d/99-obsensor-libusb.rules ]; then
  echo "리눅스에서 오르벡 카메라를 처음 쓴다면 USB 권한 규칙을 한 번 설치하세요 (sudo 필요):"
  echo "  sudo cp scripts/99-obsensor-libusb.rules /etc/udev/rules.d/ && sudo udevadm control --reload-rules && sudo udevadm trigger"
  echo "  그다음 카메라를 뽑았다가 다시 꽂기"
fi
