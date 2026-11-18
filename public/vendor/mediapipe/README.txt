@mediapipe/tasks-vision 1.2.3 (Apache-2.0, https://github.com/google-ai-edge/mediapipe) — 브라우저 손 인식용.
vision_bundle.mjs 와 wasm/vision_wasm_internal.{js,wasm} 을 npm 패키지에서 그대로 복사했습니다 (전시장처럼 인터넷이 없어도 돌아가게 로컬로 제공).
손 인식 모델(hand_landmarker.task)은 models/ 폴더 (README 참고). 없으면 인터넷에서 받아 옵니다.
