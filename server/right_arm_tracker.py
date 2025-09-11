import cv2
import json
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

# pip install mediapipe==0.10.14 opencv-python
import mediapipe as mp
import math

"""
Right Arm Realtime (Unified)
- 카메라 자동 감지(backend/index) + 안전한 열기
- 오른팔(어깨·팔꿈치·손목·엉덩이) 픽셀 좌표 및 각도(어깨각, 팔꿈치각)
- 최신 1건: right_arm_latest.json (들여쓰기)
- 로그 누적: right_arm_log.jsonl (JSON Lines, 프레임당 1줄)
- WinError 5 회피: 임시파일 교체 없이 직접 덮어쓰기
- 창에서 'q' 로 종료
"""

# -------- 설정 --------
PREFERRED_CAM_INDEX = 0       # 예상 인덱스(없으면 자동으로 다른 인덱스/백엔드 탐색)
FRAME_WIDTH = 1280
FRAME_HEIGHT = 720
SAVE_DIR = Path("./outputs")
LATEST_JSON = SAVE_DIR / "right_arm_latest.json"
LOG_JSONL = SAVE_DIR / "right_arm_log.jsonl"
SHOW_WINDOW = True
TARGET_SIDE = "right"         # "right" 고정(오른팔)
MIN_DET_CONF = 0.6
MIN_TRK_CONF = 0.6
FPS_LIMIT = 30                # 저장/표시 상한 FPS

# -------- 유틸 --------
KST = timezone(timedelta(hours=9))  # Asia/Seoul (UTC+9)

def now_kst_iso():
    return datetime.now(KST).isoformat(timespec="milliseconds")

def to_px(landmark, w, h):
    return int(landmark.x * w), int(landmark.y * h), float(landmark.visibility)

def angle_deg(a, b, c):
    """
    점 b를 꼭짓점으로 하는 ∠ABC (벡터 BA, BC)의 각도(도)
    a, b, c는 (x,y) 튜플
    """
    bax = a[0] - b[0]; bay = a[1] - b[1]
    bcx = c[0] - b[0]; bcy = c[1] - b[1]
    dot = bax*bcx + bay*bcy
    na = math.hypot(bax, bay)
    nb = math.hypot(bcx, bcy)
    if na == 0 or nb == 0:
        return None
    cosv = max(-1.0, min(1.0, dot/(na*nb)))
    return math.degrees(math.acos(cosv))

def safe_write_latest(obj, path: Path):
    """윈도우에서 임시파일 교체 없이 직접 덮어쓰기(WinError 5 회피)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)

def append_jsonl(obj, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")

# -------- 카메라 자동 감지 --------

def _backend_name(b: int) -> str:
    mapping = {getattr(cv2, "CAP_ANY", 0): "CAP_ANY"}
    if hasattr(cv2, "CAP_DSHOW"): mapping[getattr(cv2, "CAP_DSHOW")] = "CAP_DSHOW"
    if hasattr(cv2, "CAP_MSMF"):  mapping[getattr(cv2, "CAP_MSMF")]  = "CAP_MSMF"
    return mapping.get(b, str(b))

def open_camera_auto(preferred_index: int = 0,
                     indices: list[int] | None = None,
                     backends: list[int] | None = None):
    if indices is None:
        # 우선 preferred → 0 → 1→2→3→4
        order = []
        for x in [preferred_index, 0, 1, 2, 3, 4]:
            if x not in order:
                order.append(x)
        indices = order
    if backends is None:
        backends = [getattr(cv2, "CAP_ANY", 0)]
        if hasattr(cv2, "CAP_DSHOW"): backends.append(getattr(cv2, "CAP_DSHOW"))
        if hasattr(cv2, "CAP_MSMF"):  backends.append(getattr(cv2, "CAP_MSMF"))

    for b in backends:
        for i in indices:
            cap = cv2.VideoCapture(i, b)
            if not cap.isOpened():
                cap.release()
                continue
            # 일부 드라이버는 읽기 전 해상도 세팅을 요구
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
            ok, frame = cap.read()
            if ok and frame is not None:
                w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                print(f"[INFO] Camera opened: index={i}, backend={_backend_name(b)}, size={w}x{h}")
                return cap, i, b
            cap.release()
    return None, None, None

# -------- MediaPipe 초기화 --------
mp_pose = mp.solutions.pose
pose = mp_pose.Pose(
    model_complexity=1,
    enable_segmentation=False,
    min_detection_confidence=MIN_DET_CONF,
    min_tracking_confidence=MIN_TRK_CONF,
    smooth_landmarks=True
)

# -------- 메인 --------

def main():
    cap, used_idx, used_backend = open_camera_auto(PREFERRED_CAM_INDEX)
    if cap is None:
        raise RuntimeError("카메라를 열 수 없습니다. (다른 앱 점유/권한/드라이버 확인)")

    prev_t = 0.0
    print("[INFO] 실시간 오른팔 좌표 추출 시작… (종료: q)")

    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                print("[WARN] 프레임 읽기 실패")
                break

            h, w = frame.shape[:2]
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            res = pose.process(rgb)
            landmarks = res.pose_landmarks.landmark if res.pose_landmarks else None

            if landmarks:
                if TARGET_SIDE == "right":
                    idx_shoulder = mp_pose.PoseLandmark.RIGHT_SHOULDER.value
                    idx_elbow    = mp_pose.PoseLandmark.RIGHT_ELBOW.value
                    idx_wrist    = mp_pose.PoseLandmark.RIGHT_WRIST.value
                    idx_hip      = mp_pose.PoseLandmark.RIGHT_HIP.value
                else:
                    idx_shoulder = mp_pose.PoseLandmark.LEFT_SHOULDER.value
                    idx_elbow    = mp_pose.PoseLandmark.LEFT_ELBOW.value
                    idx_wrist    = mp_pose.PoseLandmark.LEFT_WRIST.value
                    idx_hip      = mp_pose.PoseLandmark.LEFT_HIP.value

                sh = landmarks[idx_shoulder]; el = landmarks[idx_elbow]
                wr = landmarks[idx_wrist];   hp = landmarks[idx_hip]

                sx, sy, sv = to_px(sh, w, h)
                ex, ey, ev = to_px(el, w, h)
                wx, wy, wv = to_px(wr, w, h)
                hx, hy, hv = to_px(hp, w, h)

                shoulder_angle = angle_deg((ex, ey), (sx, sy), (hx, hy))  # 팔꿈치-어깨-엉덩이
                elbow_angle    = angle_deg((sx, sy), (ex, ey), (wx, wy))  # 어깨-팔꿈치-손목

                record = {
                    "ts_kst": now_kst_iso(),
                    "image_size": {"w": w, "h": h},
                    "side": TARGET_SIDE,
                    "shoulder_px": [sx, sy, sv],
                    "elbow_px":    [ex, ey, ev],
                    "wrist_px":    [wx, wy, wv],
                    "hip_px":      [hx, hy, hv],
                    "angles_deg": {
                        "shoulder": shoulder_angle,
                        "elbow": elbow_angle
                    }
                }

                # 저장
                try:
                    safe_write_latest(record, LATEST_JSON)
                    append_jsonl(record, LOG_JSONL)
                except Exception as e:
                    # 드문 파일 잠금/권한 문제 로그
                    print(f"[WARN] 파일 저장 실패: {e}")

                if SHOW_WINDOW:
                    # 시각화
                    for (px, py) in [(sx, sy), (ex, ey), (wx, wy), (hx, hy)]:
                        cv2.circle(frame, (px, py), 6, (0, 255, 0), -1)
                    cv2.line(frame, (sx, sy), (ex, ey), (255, 255, 255), 2)
                    cv2.line(frame, (sx, sy), (hx, hy), (200, 200, 200), 2)
                    cv2.line(frame, (ex, ey), (wx, wy), (200, 200, 200), 2)

                    # 텍스트
                    t1 = f"Shoulder: {shoulder_angle:.1f}°" if shoulder_angle is not None else "Shoulder: N/A"
                    t2 = f"Elbow: {elbow_angle:.1f}°" if elbow_angle is not None else "Elbow: N/A"
                    t3 = f"R-shoulder px=({sx},{sy})"
                    cv2.putText(frame, t1, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255,255,255), 2)
                    cv2.putText(frame, t2, (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255,255,255), 2)
                    cv2.putText(frame, t3, (10, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255,255,255), 2)

            if SHOW_WINDOW:
                cv2.imshow("Right Arm (MediaPipe Pose)", frame)
                if (cv2.waitKey(1) & 0xFF) == ord('q'):
                    break

            # 소프트 FPS cap
            now = time.time()
            dt = now - prev_t
            min_dt = 1.0 / FPS_LIMIT
            if dt < min_dt:
                time.sleep(min_dt - dt)
            prev_t = time.time()

    except KeyboardInterrupt:
        print("\n[INFO] 사용자 중단(Ctrl+C). 파일 저장 완료.")
    finally:
        cap.release()
        if SHOW_WINDOW:
            cv2.destroyAllWindows()
        pose.close()
        print(f"[DONE] latest: {LATEST_JSON.absolute()}")
        print(f"[DONE] log:    {LOG_JSONL.absolute()}")


if __name__ == "__main__":
    main()
