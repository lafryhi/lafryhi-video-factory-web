from __future__ import annotations

from decimal import Decimal, ROUND_FLOOR, ROUND_HALF_UP
import math


def frames_for_duration(duration_seconds: float, fps: int) -> int:
    if fps <= 0:
        raise ValueError("FPS must be greater than zero.")
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("Duration must be a finite number greater than zero.")
    value = Decimal(str(duration_seconds)) * Decimal(fps)
    return max(1, int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)))


def allocate_scene_frames(
    durations_seconds: list[float],
    fps: int,
    *,
    total_duration_seconds: float | None = None,
) -> list[int]:
    """Allocate whole frames with largest remainders while preserving one total."""
    if not durations_seconds:
        raise ValueError("At least one scene duration is required.")
    if any(not math.isfinite(value) or value <= 0 for value in durations_seconds):
        raise ValueError("Every scene duration must be a finite number greater than zero.")
    requested_total = sum(durations_seconds) if total_duration_seconds is None else total_duration_seconds
    if not math.isfinite(requested_total) or requested_total <= 0:
        raise ValueError("Project duration must be a finite number greater than zero.")
    total_frames = max(len(durations_seconds), frames_for_duration(requested_total, fps))
    weights = [Decimal(str(value)) for value in durations_seconds]
    weight_total = sum(weights)
    exact = [Decimal(total_frames) * weight / weight_total for weight in weights]
    allocated = [max(1, int(value.to_integral_value(rounding=ROUND_FLOOR))) for value in exact]

    difference = total_frames - sum(allocated)
    if difference > 0:
        order = sorted(range(len(exact)), key=lambda i: (exact[i] - int(exact[i]), -i), reverse=True)
        for offset in range(difference):
            allocated[order[offset % len(order)]] += 1
    elif difference < 0:
        order = sorted(range(len(exact)), key=lambda i: (exact[i] - int(exact[i]), i))
        for index in order:
            while difference < 0 and allocated[index] > 1:
                allocated[index] -= 1
                difference += 1
    if sum(allocated) != total_frames:
        raise ValueError("Scene durations are too short to allocate at least one frame per scene.")
    return allocated
