from __future__ import annotations

import subprocess
from typing import Callable


def shutdown_process(
    process: subprocess.Popen[str],
    *,
    timeout_seconds: float = 2.0,
    log: Callable[[str], None] | None = None,
) -> None:
    if process.poll() is not None:
        process.wait()
        return
    try:
        process.terminate()
        process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        if log:
            log(f"Process {process.pid} did not terminate; forcing shutdown")
        process.kill()
        process.wait(timeout=timeout_seconds)
