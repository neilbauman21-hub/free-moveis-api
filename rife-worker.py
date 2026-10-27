#!/usr/bin/env python3
"""RIFE worker: read a completed local video file, interpolate it with RIFE on
the GPU, and write Y4M video to stdout. Diagnostics go to stderr only.

usage: rife-worker.py <input-file> [fps]

fps may be an integer or a decimal (e.g. 60, 59.94), max 240.

stdout carries the Y4M stream (piped straight into ffmpeg by the Node API),
so nothing else may ever print to stdout here.
"""
import math
import sys
from pathlib import Path

import vapoursynth as vs

# Same explicit plugin paths we verified working (autoload is not configured).
FFMS2_PLUGIN = "/usr/lib64/libffms2.so.5"
RIFE_PLUGIN = "/usr/lib64/vapoursynth/librife.so"

# RIFE v4.6 — the model that supports arbitrary fps (25 -> 40 etc.).
MODEL = 23
GPU_ID = 0  # RX 7700 XT


def main():
    if len(sys.argv) < 2:
        print("usage: rife-worker.py <input-file> [fps]", file=sys.stderr)
        return 2
    src = Path(sys.argv[1]).resolve()
    if not src.is_file():
        print(f"input not found: {src}", file=sys.stderr)
        return 2
    raw_fps = sys.argv[2] if len(sys.argv) > 2 else "40"
    try:
        fps = float(raw_fps)
    except ValueError:
        print(f"invalid fps: {raw_fps}", file=sys.stderr)
        return 2
    if not math.isfinite(fps) or not 1 <= fps <= 240:
        print(f"fps out of range (1-240): {raw_fps}", file=sys.stderr)
        return 2

    # RIFE takes a rational frame rate. Millifps precision covers 23.976,
    # 29.97 and 59.94 without accumulating float error.
    fps_den = 1000
    fps_num = round(fps * fps_den)
    divisor = math.gcd(fps_num, fps_den)
    fps_num //= divisor
    fps_den //= divisor

    core = vs.core
    core.std.LoadPlugin(path=FFMS2_PLUGIN)
    core.std.LoadPlugin(path=RIFE_PLUGIN)

    clip = core.ffms2.Source(source=str(src))

    rgb = core.resize.Bicubic(clip, format=vs.RGBS, matrix_in_s="709")
    smooth = core.rife.RIFE(
        rgb,
        model=MODEL,
        fps_num=fps_num,
        fps_den=fps_den,
        gpu_id=GPU_ID,
        gpu_thread=2,
        sc=False,
    )
    out = core.resize.Bicubic(smooth, format=vs.YUV420P8, matrix_s="709")

    try:
        out.output(sys.stdout.buffer, y4m=True)
    except BrokenPipeError:
        # ffmpeg died / client disconnected; that is fine, not an error.
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
