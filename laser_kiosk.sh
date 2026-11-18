#!/bin/bash
# 레이저 챌린지 전시용 실행 (macOS · 리눅스): 서버를 켜고 크롬을 전체 화면으로 엽니다.
# 사용법: ./laser_kiosk.sh        (카메라 없이 마우스·키보드만: ./laser_kiosk.sh --no-camera)
cd "$(dirname "$(readlink -f "$0")")"
./run.sh "$@" || exit 1
PORT=$(.venv/bin/python -c "import yaml;print(yaml.safe_load(open('config.yaml'))['server']['port'])")
URL="http://localhost:$PORT/laser"
FLAGS="--kiosk --autoplay-policy=no-user-gesture-required --user-data-dir=/tmp/laser-chrome"
if [ "$(uname)" = "Darwin" ]; then
  open -na "Google Chrome" --args $FLAGS "$URL"
else
  (google-chrome $FLAGS "$URL" || chromium $FLAGS "$URL" || chromium-browser $FLAGS "$URL") >/dev/null 2>&1 &
fi
