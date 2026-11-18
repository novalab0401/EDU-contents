#!/bin/bash
# 카오스 타워 서버 종료
pkill -f "\.venv/bin/python server\.py --port" && echo "서버를 종료했습니다." || echo "실행 중인 서버가 없습니다."
