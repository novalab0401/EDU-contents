#!/bin/bash
# 카오스 타워 서버 시작 (백그라운드). 사용법: ./run.sh [--no-camera]  → http://<젯슨 IP>:8001
cd "$(dirname "$(readlink -f "$0")")"
[ -x .venv/bin/python ] || { echo "먼저 설치하세요: ./setup.sh"; exit 1; }
PORT=$(.venv/bin/python -c "import yaml;print(yaml.safe_load(open('config.yaml'))['server']['port'])")
mkdir -p data
if curl -s -o /dev/null "localhost:$PORT/api/health"; then
  echo "이미 실행 중입니다."
else
  if curl -s -o /dev/null "localhost:8000/api/state"; then
    echo "주의: 8000 포트의 action-text가 카메라를 쓰고 있으면 손 인식 없이 마우스로만 동작합니다. (~/action-text/stop.sh 후 다시 실행)"
  fi
  GLOG_minloglevel=2 TF_CPP_MIN_LOG_LEVEL=2 nohup .venv/bin/python server.py --port "$PORT" "$@" >> data/server.log 2>&1 &
  for i in $(seq 1 40); do curl -s -o /dev/null "localhost:$PORT/api/health" && break; sleep 0.5; done
  curl -s -o /dev/null "localhost:$PORT/api/health" || { echo "서버가 뜨지 않았습니다. 로그:"; tail -20 data/server.log; exit 1; }
  for i in $(seq 1 20); do   # 손 인식 모델 준비 (최대 10초)
    curl -s "localhost:$PORT/api/hand" | grep -q '"available":true\|"error":"[^"]' && break; sleep 0.5
  done
fi
curl -s "localhost:$PORT/api/hand" | .venv/bin/python -c "
import json, sys
s = json.load(sys.stdin)
print('손 인식:', f\"켜짐 ({s.get('delegate', '').upper()}, {s.get('fps', 0)} fps)\" if s.get('available') else f\"꺼짐 — {s.get('error') or '준비 중'} (마우스로 조작)\")"
echo "게임: http://localhost:$PORT  (다른 PC: http://$(hostname -I | awk '{print $1}'):$PORT)   손 인식 화면: /video"
