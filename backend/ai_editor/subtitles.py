import textwrap
from .models import SubtitleStyle


def cues_for_range(plan, source_id, start, end):
    words = [o for o in plan.operations if o.type == "subtitle" and o.sourceId == source_id and o.start < end and o.end > start]
    cues = []
    for word in sorted(words, key=lambda o: o.start):
        a, b = max(0, word.start - start), min(end, word.end) - start
        if cues and a - cues[-1][1] < .6 and len(cues[-1][2]) + len(word.text) < plan.subtitleStyle.maxCharsPerLine:
            cues[-1] = (cues[-1][0], b, cues[-1][2] + " " + word.text)
        else: cues.append((a, b, word.text))
    return cues


def ass(cues, style: SubtitleStyle, width, height):
    def timestamp(t):
        cs = round(t * 100)
        return f"{cs // 360000}:{cs // 6000 % 60:02}:{cs // 100 % 60:02}.{cs % 100:02}"
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans,{style.fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,{3 if style.background else 1},{style.outline},0,{dict(bottom=2,center=5,top=8)[style.position]},40,40,70,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    for start, end, text in cues:
        # Strip ASS control syntax; subtitle text is data, never a filter expression.
        clean = text.replace("\\", " ").replace("{", "(").replace("}", ")").replace("\n", " ").replace("\r", " ")
        clean = "\\N".join(textwrap.wrap(clean, style.maxCharsPerLine))
        header += f"Dialogue: 0,{timestamp(start)},{timestamp(end)},Default,,0,0,0,,{clean}\n"
    return header
