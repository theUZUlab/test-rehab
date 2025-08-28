from __future__ import annotations
import json
import os
import time
from typing import Any

BASE_DIR = os.path.dirname(__file__)
RESULTS_DIR = os.path.join(BASE_DIR, "public", "results")
os.makedirs(RESULTS_DIR, exist_ok=True)

LATEST_PATH = os.path.join(RESULTS_DIR, "latest.json")


def _atomic_write_json(path: str, data: dict[str, Any]) -> None:
    """
    JSON을 임시파일로 쓴 후 os.replace로 교체 (윈도우에서도 안전)
    """
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def update_latest(
    *,
    exercise: str,
    phase: str,
    rep_count: int,
    last_feedback: str | list[str],
    point: dict[str, float] | None = None,
    extra_summary: dict[str, Any] | None = None,
) -> None:
    """
    실시간 생산자(추적/포즈모듈 등)에서 매 프레임·매 이벤트마다 호출.
    지금은 좌표(point)만 기록하고, exercise 고정/summary 공란 처리.
    """
    data = {
        "ts": time.time(),
        "exercise": "sit_to_stand",           # 고정
        "summary": "",                        # 지금은 빈 문자열
        "point": point or {"x": 0.0, "y": 0.0, "z": 0.0},
    }

    try:
        _atomic_write_json(LATEST_PATH, data)
    except Exception as e:
        print("write error:", e)
