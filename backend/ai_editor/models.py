from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Segment(Model):
    start: float = Field(ge=0, le=1800)
    end: float = Field(gt=0, le=1800)
    text: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def ordered(self):
        if self.end <= self.start:
            raise ValueError("End must be greater than start")
        return self


class Source(Model):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    name: str = Field(max_length=250)
    duration: float = Field(gt=0, le=1800)
    hasAudio: bool
    segments: list[Segment] = Field(default_factory=list, max_length=5000)
    silences: list[Segment] = Field(default_factory=list, max_length=5000)


class Operation(Segment):
    sourceId: str = Field(pattern=r"^[a-f0-9]{32}$")
    type: Literal["cut", "remove_filler", "subtitle"]
    reason: str = Field(default="", max_length=300)


class Audio(Model):
    crossfadeMs: int = Field(default=40, ge=0, le=60)
    normalize: bool = True


class Video(Model):
    colorPreset: Literal["original", "bright", "warm", "cool", "contrast", "soft"] = "original"
    cropMode: Literal["center", "fit"] = "center"


class SubtitleStyle(Model):
    fontSize: int = Field(default=48, ge=16, le=96)
    position: Literal["bottom", "center", "top"] = "bottom"
    background: bool = True
    outline: int = Field(default=2, ge=0, le=6)
    maxCharsPerLine: int = Field(default=38, ge=12, le=70)


class EditPlan(Model):
    version: Literal[1] = 1
    sourceDuration: float = Field(gt=0, le=1800)
    targetDuration: float = Field(gt=0, le=1800)
    aspectRatio: Literal["9:16", "16:9"] = "16:9"
    operations: list[Operation] = Field(default_factory=list, max_length=5000)
    audio: Audio = Field(default_factory=Audio)
    video: Video = Field(default_factory=Video)
    subtitleStyle: SubtitleStyle = Field(default_factory=SubtitleStyle)
    language: Literal["en", "fr", "ar"] = "en"
    instruction: str = Field(default="", max_length=4000)
    planner: Literal["conservative-rules-v1"] = "conservative-rules-v1"
    warnings: list[str] = Field(default_factory=list, max_length=100)


class AnalyzeRequest(Model):
    sessionId: str = Field(pattern=r"^[a-f0-9]{32}$")
    sourceIds: list[str] = Field(min_length=1, max_length=10)
    language: Literal["en", "fr", "ar"] = "en"


class PlanRequest(Model):
    sessionId: str = Field(pattern=r"^[a-f0-9]{32}$")
    analysisId: str = Field(pattern=r"^[a-f0-9]{32}$")
    instruction: str = Field(min_length=1, max_length=4000)
    presets: list[Literal["silence", "fillers", "subtitles", "reel", "talking", "bright", "audio"]] = Field(default_factory=list, max_length=7)
    fillerWords: list[str] = Field(default_factory=lambda: ["um", "uh", "erm", "hmm"], max_length=30)


class RenderRequest(Model):
    sessionId: str = Field(pattern=r"^[a-f0-9]{32}$")
    analysisId: str = Field(pattern=r"^[a-f0-9]{32}$")
    plan: EditPlan


def validate_sources(plan: EditPlan, sources: list[Source]):
    by_id = {s.id: s for s in sources}
    if abs(sum(s.duration for s in sources) - plan.sourceDuration) > .05:
        raise ValueError("Source duration does not match analysis")
    for op in plan.operations:
        if op.sourceId not in by_id or op.end > by_id[op.sourceId].duration + .001:
            raise ValueError("Operation is outside its source")
