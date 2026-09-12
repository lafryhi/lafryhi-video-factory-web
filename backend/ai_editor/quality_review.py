from .media import probe


def review(path, duration, width, height, expect_audio):
    if not path.is_file() or not path.stat().st_size: raise ValueError("Output file is missing or empty")
    data = probe(path)
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    checks = {"file": True, "video": True,
              "duration": abs(float(data["format"]["duration"]) - duration) < max(.25, duration * .01),
              "resolution": video["width"] == width and video["height"] == height,
              "aspectRatio": abs(video["width"] / video["height"] - width / height) < .001,
              "audio": not expect_audio or any(s["codec_type"] == "audio" for s in data["streams"])}
    if not all(checks.values()): raise ValueError(f"Output failed quality review: {checks}")
    return {"checks": checks, "visualReview": "not_configured"}
