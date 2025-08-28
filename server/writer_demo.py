import time
from save_json import update_latest

if __name__ == "__main__":
    n = 0
    while True:
        # 여기서 실제 좌표를 넣어주면 됩니다.
        # 지금은 단순히 x=n, y=n, z=n 으로 증가시킴
        point = {"x": n, "y": n, "z": n}

        update_latest(
            exercise="sit_to_stand",
            phase="idle",
            rep_count=0, 
            last_feedback="",
            point=point,  # 좌표 데이터
        )

        print("saved:", point)  # 터미널에 저장된 좌표 확인용 (디버깅)
        n += 1
        time.sleep(1)
