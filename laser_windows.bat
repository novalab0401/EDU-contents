@echo off
REM 레이저 챌린지 전시용 실행 (윈도우): 서버를 켜고 크롬을 전체 화면으로 엽니다. 끄려면 크롬에서 Alt+F4, 서버 창 닫기.
REM 사전 준비: python -m venv .venv  →  .venv\Scripts\python -m pip install -r requirements-lite.txt  (손 인식은 크롬 안에서 돌아가서 mediapipe·opencv 설치 불필요)
cd /d "%~dp0"
start "laser-server" .venv\Scripts\python server.py --no-camera
timeout /t 6 /nobreak >nul
REM --autoplay-policy: 클릭 없이도 효과음이 나게 함 / --use-fake-ui-for-media-stream: 카메라 허용 팝업 없이 바로 켬 / 크롬 경로가 다르면 아래 줄을 고치세요
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --autoplay-policy=no-user-gesture-required --use-fake-ui-for-media-stream --user-data-dir="%TEMP%\laser-chrome" http://localhost:8001/laser
