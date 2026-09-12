import re
from .models import EditPlan, Operation, Source, validate_sources


def filler_segments(segments, words):
    # Ambiguous conversational words need context; never cut 'like' or 'you know'.
    allowed = {w.strip().casefold() for w in words} - {"like", "you know", ""}
    return [s for s in segments if s.text.strip(" .,!?;:").casefold() in allowed and .08 <= s.end - s.start <= .65]


def build_plan(sources: list[Source], instruction, presets, fillers, language):
    text = instruction.casefold()
    flags = set(presets)
    if re.search(r"remove (?:long )?(?:pauses|silence)", text): flags.add("silence")
    if "filler" in text: flags.add("fillers")
    if "subtitle" in text or "caption" in text: flags.add("subtitles")
    if "reel" in text: flags.add("reel")
    if "talking" in flags: flags.update(["silence", "fillers", "audio"])
    duration = sum(s.duration for s in sources)
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s\b)", text)
    target = min(duration, max(.25, float(match[1]))) if match else min(duration, 45) if "reel" in flags else duration
    plan = EditPlan(sourceDuration=duration, targetDuration=target, instruction=instruction, language=language,
                    aspectRatio="9:16" if "reel" in flags or "9:16" in text or "vertical" in text else "16:9")
    plan.warnings.append("Conservative rule-based planner: semantic mistake detection and arbitrary instructions are not supported yet. Review every cut.")
    if target < duration: plan.warnings.append("Duration target uses the first retained footage; it does not select semantic highlights.")
    if "smart" in text: plan.warnings.append("Smart subject tracking is unavailable; cropping is centered.")
    for color in ["bright", "warm", "cool", "contrast", "soft", "original"]:
        if color in text or color in flags: plan.video.colorPreset = color
    for s in sources:
        if "silence" in flags:
            plan.operations.extend(Operation(**p.model_dump(), sourceId=s.id, type="cut", reason="long silence") for p in s.silences)
        if "fillers" in flags:
            plan.operations.extend(Operation(**p.model_dump(), sourceId=s.id, type="remove_filler", reason="isolated filler") for p in filler_segments(s.segments, fillers))
        if "subtitles" in flags:
            plan.operations.extend(Operation(**p.model_dump(), sourceId=s.id, type="subtitle") for p in s.segments)
        if not s.segments and flags.intersection({"fillers", "subtitles"}):
            plan.warnings.append(f"No transcript for {s.name}: filler removal and subtitles skipped.")
    validate_sources(plan, sources)
    return plan


def retained_ranges(plan, sources):
    validate_sources(plan, sources)
    remaining = plan.targetDuration
    result = []
    for source in sources:
        cuts = sorted((o.start, o.end) for o in plan.operations if o.sourceId == source.id and o.type != "subtitle")
        cursor = 0.0
        for start, end in cuts + [(source.duration, source.duration)]:
            if start > cursor and remaining >= .1:
                length = min(start - cursor, remaining)
                if length >= .1:
                    result.append((source, cursor, cursor + length))
                    remaining -= length
            cursor = max(cursor, end)
    if not result: raise ValueError("The plan removes all footage")
    if len(result) > 150: raise ValueError("Too many cuts: use fewer clips or less aggressive settings")
    return result
