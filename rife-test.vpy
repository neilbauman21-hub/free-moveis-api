from pathlib import Path
import vapoursynth as vs

core = vs.core

core.std.LoadPlugin(path='/usr/lib64/libffms2.so.5')
core.std.LoadPlugin(path='/usr/lib64/vapoursynth/librife.so')

clip = core.ffms2.Source(
    source=str(Path('segment-tail.bin').resolve())
)

rgb = core.resize.Bicubic(
    clip,
    format=vs.RGBS,
    matrix_in_s='709'
)

smooth = core.rife.RIFE(
    rgb,
    model=23,
    fps_num=40,
    fps_den=1,
    gpu_id=0,
    gpu_thread=2,
    sc=False
)

output = core.resize.Bicubic(
    smooth,
    format=vs.YUV420P8,
    matrix_s='709'
)

output.set_output()
