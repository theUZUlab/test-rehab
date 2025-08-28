# server/hand_tracker.py
import cv2
import mediapipe as mp
import math
import json
import time
import os
from collections import deque, Counter

# ----------------------
# 유틸
# ----------------------
def calculate_distance_cm(a, b):
    """픽셀 거리 → 대략 cm로 환산. (모니터/카메라별 실제값은 조정 필요)"""
    try:
        px_dist = math.hypot(b[0] - a[0], b[1] - a[1])
        return px_dist / 37.8  # 1cm ≈ 37.8px (임시값)
    except Exception:
        return None

def smooth_label(deque_labels):
    """최근 레이블 다수결 스무딩"""
    if not deque_labels:
        return None
    most_common = Counter(deque_labels).most_common(1)
    return most_common[0][0]

def atomic_write_json(path: str, payload: dict):
    """임시파일로 쓴 뒤 교체하여 읽기-쓰기 경합 방지"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

# ----------------------
# MediaPipe 초기화
# ----------------------
mp_drawing = mp.solutions.drawing_utils
mp_hands = mp.solutions.hands

# ----------------------
# 저장 경로 (루트/test-rehab 기준)
# ----------------------
BASE_DIR = os.path.dirname(__file__)                 # .../server
JSON_PATH = os.path.join(BASE_DIR, "realtime_hand_coordinates.json")

# ----------------------
# 웹캠 열기
# ----------------------
cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)  # 윈도우에서 접근 안 되면 CAP_MSMF 로 바꿔보세요
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

# 스무딩용 큐
N_SMOOTH = 5
hand_label_queues = [deque(maxlen=N_SMOOTH), deque(maxlen=N_SMOOTH)]

with mp_hands.Hands(
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5,
    max_num_hands=2
) as hands:
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            print("카메라에서 영상 읽기 실패")
            break

        frame = cv2.flip(frame, 1)
        h, w, _ = frame.shape
        image_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results_hands = hands.process(image_rgb)
        image_bgr = frame.copy()

        # 최종 JSON 페이로드
        data = {"timestamp": time.time(), "hands": []}

        if results_hands.multi_hand_landmarks:
            for hand_idx, (hand_landmarks, hand_label) in enumerate(
                zip(results_hands.multi_hand_landmarks, results_hands.multi_handedness)
            ):
                # 그리기
                mp_drawing.draw_landmarks(image_bgr, hand_landmarks, mp_hands.HAND_CONNECTIONS)

                # 좌표 리스트 (px)
                landmarks = [(int(lm.x * w), int(lm.y * h)) for lm in hand_landmarks.landmark]
                wrist = landmarks[0]

                # 손가락 끝 인덱스/이름
                fingertip_ids = [4, 8, 12, 16, 20]
                finger_names = ["Thumb", "Index", "Middle", "Ring", "Pinky"]

                # 왼손/오른손(화면 기준) 라벨 추정 + 스무딩
                hand_x = sum([lm[0] for lm in landmarks]) / len(landmarks)
                label = "Left" if hand_x < w / 2 else "Right"
                if hand_idx >= len(hand_label_queues):
                    hand_label_queues.append(deque(maxlen=N_SMOOTH))
                hand_label_queues[hand_idx].append(label)
                smoothed_label = smooth_label(hand_label_queues[hand_idx])

                # 각 손가락 끝 좌표 & 손목-끝 거리
                fingers_data = {}
                for name, tip_id in zip(finger_names, fingertip_ids):
                    tip = landmarks[tip_id]
                    length_cm = calculate_distance_cm(wrist, tip)
                    # 시각화
                    cv2.line(image_bgr, wrist, tip, (255, 0, 0), 2)
                    cv2.circle(image_bgr, tip, 5, (0, 255, 0), -1)
                    cv2.putText(
                        image_bgr,
                        f"{name} ({tip[0]},{tip[1]})",
                        (tip[0] + 5, tip[1] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.5,
                        (0, 255, 255),
                        1,
                    )
                    fingers_data[name] = {"x": tip[0], "y": tip[1], "length_cm": length_cm}

                data["hands"].append({
                    "hand_index": hand_idx,
                    "hand_label": smoothed_label,
                    "fingers": fingers_data
                })

                # 손 라벨 표시
                cv2.putText(
                    image_bgr, smoothed_label,
                    (wrist[0] - 20, wrist[1] - 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2
                )

        # 콘솔 로그(선택)
        for hand in data["hands"]:
            print(f"{hand['hand_label']} Hand (Index {hand['hand_index']}):")
            for finger_name, finger_info in hand["fingers"].items():
                x, y, length = finger_info["x"], finger_info["y"], finger_info["length_cm"]
                print(f"  {finger_name:6}: ({x:4}, {y:4})  Length: {length if length is not None else float('nan'):.1f}cm")
            print("-" * 50)

        # JSON 저장 (원자적)
        try:
            atomic_write_json(JSON_PATH, data)
        except Exception as e:
            print("write error:", e)

        # 프리뷰 창
        cv2.imshow("Hand Tracking Stable", image_bgr)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

cap.release()
cv2.destroyAllWindows()
