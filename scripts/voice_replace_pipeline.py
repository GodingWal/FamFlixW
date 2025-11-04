"""Pipeline script to replace a video's dialogue track with a Chatterbox zero-shot cloned voice.

This script orchestrates the end-to-end workflow:
    1. Extract the audio track from a source video with ffmpeg.
    2. Transcribe the dialogue with OpenAI Whisper to obtain time-aligned segments.
    3. Generate a cloned-voice performance for each segment with the Chatterbox model (local CLI).
    4. Time-stretch every generated segment to match the original pacing.
    5. Assemble the processed segments into a final dialogue track and swap it into the video.

The implementation favours clarity over absolute efficiency so that individual steps can be
swapped out or customised easily. Each stage can also be skipped when its artefact is supplied
explicitly via the command-line options.

Prerequisites
-------------
- ffmpeg and ffprobe available on the PATH.
- Python packages: `openai-whisper`, `requests`, `pydub`, `torch`, `torchaudio`, and `chatterbox-tts`.
- A clean voice sample WAV/MP3 that will be used as the audio prompt for zero-shot cloning.

Example
-------
python scripts/voice_replace_pipeline.py \\
    --input-video ./input.mp4 \\
    --output-video ./output.mp4 \\
    --audio-prompt ./voice_sample.wav \\
    --device cpu

The script will create intermediate files inside a temporary working directory, printing their
locations so you can review or reuse them as needed.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

import requests

try:
    import whisper
except ImportError as exc:  # pragma: no cover - whisper is an optional dependency at runtime
    raise SystemExit(
        "The `openai-whisper` package is required for transcription.\n"
        "Install it with `pip install openai-whisper`."
    ) from exc

try:
    from pydub import AudioSegment
except ImportError as exc:  # pragma: no cover - pydub is an optional dependency at runtime
    raise SystemExit(
        "The `pydub` package is required for audio assembly.\n"
        "Install it with `pip install pydub`."
    ) from exc


@dataclass
class TranscriptSegment:
    """A single Whisper segment with timing metadata."""

    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass
class GeneratedSegment:
    """Represents a synthesized audio clip aligned to a transcript segment."""

    transcript: TranscriptSegment
    audio_path: Path


class PipelineError(RuntimeError):
    """Raised when an external command or API call fails."""


def run_command(command: List[str], *, cwd: Optional[Path] = None) -> None:
    """Execute a shell command, raising an informative error if it fails."""

    result = subprocess.run(command, cwd=cwd, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout
        raise PipelineError(f"Command {' '.join(command)} failed: {stderr}")


def extract_audio(input_video: Path, audio_output: Path) -> None:
    """Extract the primary audio track from a video file using ffmpeg."""

    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_video),
            "-q:a",
            "0",
            "-map",
            "a",
            str(audio_output),
        ]
    )


def transcribe_audio(
    audio_path: Path,
    *,
    model_name: str,
    device: Optional[str] = None,
    temperature: float = 0.0,
) -> List[TranscriptSegment]:
    """Transcribe an audio file with Whisper and return its time-aligned segments."""

    model = whisper.load_model(model_name, device=device)
    result = model.transcribe(str(audio_path), temperature=temperature, verbose=False)
    segments = [
        TranscriptSegment(start=seg["start"], end=seg["end"], text=seg["text"].strip())
        for seg in result.get("segments", [])
        if seg.get("text")
    ]
    if not segments:
        raise PipelineError("Whisper produced no transcript segments."
                            " Check the audio quality or pick a larger model.")
    return segments


def write_transcript(segments: Iterable[TranscriptSegment], output_path: Path) -> None:
    """Persist transcript data as JSON for later inspection or reuse."""

    serialisable = [
        {"start": seg.start, "end": seg.end, "text": seg.text}
        for seg in segments
    ]
    output_path.write_text(json.dumps(serialisable, indent=2), encoding="utf-8")


def find_python() -> str:
    return os.environ.get("PYTHON_BIN", "python3")


def chatterbox_tts(
    *,
    text: str,
    audio_prompt: Path,
    output_path: Path,
    device: str = "cpu",
    multilingual: bool = False,
    language: Optional[str] = None,
    exaggeration: Optional[float] = None,
    cfg_weight: Optional[float] = None,
) -> None:
    """Call the local Chatterbox CLI wrapper to synthesize speech and save the audio clip."""
    python_bin = find_python()
    script_path = Path(__file__).parent / "chatterbox_tts.py"
    cmd: List[str] = [
        python_bin,
        str(script_path),
        "--text",
        text,
        "--out",
        str(output_path),
        "--speaker-wav",
        str(audio_prompt),
        "--device",
        device,
    ]
    if multilingual:
        cmd.append("--multilingual")
    if language:
        cmd.extend(["--language", language])
    if exaggeration is not None:
        cmd.extend(["--exaggeration", str(exaggeration)])
    if cfg_weight is not None:
        cmd.extend(["--cfg-weight", str(cfg_weight)])

    result = subprocess.run(cmd, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise PipelineError(f"Chatterbox CLI failed: {result.stderr or result.stdout}")
    # Parse JSON line to report whether the prompt was used
    try:
        last_line = (result.stdout or "").strip().splitlines()[-1]
        meta = json.loads(last_line) if last_line else {}
        used = meta.get("used_prompt_arg")
        norm = meta.get("normalized_prompt_path")
        if used is not None:
            print(f"[chatterbox] used_prompt_arg={used} normalized_prompt_path={norm}")
    except Exception:
        # Non-fatal if CLI output wasn't JSON
        pass


def segment_audio_duration(path: Path) -> float:
    """Return the duration of an audio file using ffprobe."""

    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise PipelineError(f"ffprobe failed: {result.stderr.strip()}")

    try:
        return float(result.stdout.strip())
    except ValueError as exc:  # pragma: no cover - depends on ffprobe output
        raise PipelineError(f"Unable to parse duration from ffprobe output: {result.stdout}") from exc


def build_atempo_filter(speed: float) -> str:
    """Construct a valid ffmpeg atempo filter string for an arbitrary speed multiplier."""

    # The atempo filter only supports values in (0.5, 2.0], so we may need to chain filters.
    filters: List[str] = []
    remaining = speed
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        filters.append("atempo=0.5")
        remaining *= 2.0
    filters.append(f"atempo={remaining:.6f}")
    return ",".join(filters)


def stretch_segment(input_path: Path, output_path: Path, target_duration: float) -> None:
    """Time-stretch an audio clip so that its duration matches the target duration."""

    current_duration = segment_audio_duration(input_path)
    if current_duration == 0:
        raise PipelineError(f"Segment {input_path} has zero duration; cannot stretch.")

    speed = current_duration / target_duration if target_duration else 1.0
    filter_chain = build_atempo_filter(speed)

    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-filter:a",
            filter_chain,
            str(output_path),
        ]
    )


def assemble_segments(segments: Iterable[GeneratedSegment], output_path: Path) -> None:
    """Overlay the generated dialogue segments into a single audio track."""

    ordered = sorted(segments, key=lambda seg: seg.transcript.start)
    if not ordered:
        raise PipelineError("No generated segments provided for assembly.")

    final_duration_ms = int(math.ceil(ordered[-1].transcript.end * 1000)) + 500
    final_audio = AudioSegment.silent(duration=final_duration_ms)

    for seg in ordered:
        clip = AudioSegment.from_file(seg.audio_path, format="wav")
        position_ms = int(seg.transcript.start * 1000)
        final_audio = final_audio.overlay(clip, position=position_ms)

    final_audio.export(output_path, format="wav")


def replace_audio_track(
    input_video: Path,
    new_audio: Path,
    output_video: Path,
) -> None:
    """Mux a video file with a replacement audio track."""

    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_video),
            "-i",
            str(new_audio),
            "-c:v",
            "copy",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-shortest",
            str(output_video),
        ]
    )


def generate_segments(
    *,
    segments: Iterable[TranscriptSegment],
    audio_prompt: Path,
    workdir: Path,
    device: str = "cpu",
    multilingual: bool = False,
    language: Optional[str] = None,
    exaggeration: Optional[float] = None,
    cfg_weight: Optional[float] = None,
) -> List[GeneratedSegment]:
    """Generate and time-stretch Chatterbox audio clips for each transcript segment."""

    generated: List[GeneratedSegment] = []
    for index, segment in enumerate(segments):
        raw_clip = workdir / f"segment_{index:04d}_raw.wav"
        stretched_clip = workdir / f"segment_{index:04d}_aligned.wav"

        chatterbox_tts(
            text=segment.text,
            audio_prompt=audio_prompt,
            output_path=raw_clip,
            device=device,
            multilingual=multilingual,
            language=language,
            exaggeration=exaggeration,
            cfg_weight=cfg_weight,
        )

        stretch_segment(raw_clip, stretched_clip, target_duration=segment.duration or 1e-3)
        generated.append(GeneratedSegment(transcript=segment, audio_path=stretched_clip))

    return generated


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replace a video's dialogue with a Chatterbox cloned voice.")
    parser.add_argument("--input-video", type=Path, required=True, help="Source video file")
    parser.add_argument("--output-video", type=Path, required=True, help="Destination video file")
    parser.add_argument("--audio-prompt", type=Path, required=True, help="Path to voice sample WAV/MP3 used as audio prompt")
    parser.add_argument(
        "--whisper-model",
        default="medium",
        help="Whisper model name (tiny, base, small, medium, large, large-v2, ...)",
    )
    parser.add_argument(
        "--whisper-device",
        default=None,
        help="Device override for Whisper (e.g. cuda, cpu). Defaults to auto-detection.",
    )
    parser.add_argument(
        "--whisper-temperature",
        type=float,
        default=0.0,
        help="Sampling temperature for Whisper decoding.",
    )
    parser.add_argument(
        "--transcript-json",
        type=Path,
        help="Optional pre-generated transcript JSON (skip Whisper step)",
    )
    parser.add_argument(
        "--save-transcript",
        action="store_true",
        help="Write the generated transcript to <output-video>.transcript.json",
    )
    # Chatterbox synthesis params
    parser.add_argument("--device", default=os.environ.get("CHATTERBOX_DEVICE", "cpu"), help="torch device: cpu or cuda")
    parser.add_argument("--multilingual", action="store_true", help="Use multilingual model")
    parser.add_argument("--language", help="Language id for multilingual model (e.g. en, fr, zh)")
    parser.add_argument("--exaggeration", type=float, default=None, help="Emotion/exaggeration control (0..1)")
    parser.add_argument("--cfg-weight", dest="cfg_weight", type=float, default=None, help="Guidance weight (0..1)")
    parser.add_argument(
        "--keep-workdir",
        action="store_true",
        help="Preserve the temporary working directory instead of deleting it",
    )
    return parser.parse_args(argv)


def load_transcript_from_json(path: Path) -> List[TranscriptSegment]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PipelineError(f"Failed to parse transcript JSON {path}: {exc}") from exc

    segments: List[TranscriptSegment] = []
    for item in data:
        try:
            segments.append(
                TranscriptSegment(start=float(item["start"]), end=float(item["end"]), text=str(item["text"]))
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise PipelineError(f"Invalid transcript entry: {item}") from exc
    return segments


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    if not args.input_video.exists():
        raise PipelineError(f"Input video {args.input_video} does not exist.")

    with tempfile.TemporaryDirectory(prefix="voice-pipeline-") as tempdir_str:
        tempdir = Path(tempdir_str)
        print(f"Working directory: {tempdir}")

        extracted_audio = tempdir / "source_audio.wav"
        extract_audio(args.input_video, extracted_audio)
        print(f"Extracted audio -> {extracted_audio}")

        if args.transcript_json:
            segments = load_transcript_from_json(args.transcript_json)
        else:
            segments = transcribe_audio(
                extracted_audio,
                model_name=args.whisper_model,
                device=args.whisper_device,
                temperature=args.whisper_temperature,
            )
        print(f"Transcribed {len(segments)} segments")

        if args.save_transcript:
            transcript_path = args.output_video.with_suffix(args.output_video.suffix + ".transcript.json")
            write_transcript(segments, transcript_path)
            print(f"Transcript saved -> {transcript_path}")

        generated_segments = generate_segments(
            segments=segments,
            audio_prompt=args.audio_prompt,
            workdir=tempdir,
            device=args.device,
            multilingual=args.multilingual,
            language=args.language,
            exaggeration=args.exaggeration,
            cfg_weight=args.cfg_weight,
        )
        print(f"Generated {len(generated_segments)} voice segments")

        final_audio = tempdir / "final_dialogue.wav"
        assemble_segments(generated_segments, final_audio)
        print(f"Assembled dialogue track -> {final_audio}")

        replace_audio_track(args.input_video, final_audio, args.output_video)
        print(f"Final video -> {args.output_video}")

        if args.keep_workdir:
            preserved = Path(str(args.output_video) + ".workdir")
            preserved.mkdir(parents=True, exist_ok=True)
            for item in tempdir.iterdir():
                destination = preserved / item.name
                if item.is_file():
                    destination.write_bytes(item.read_bytes())
                elif item.is_dir():
                    subprocess.run(["cp", "-R", str(item), str(destination)], check=False)
            print(f"Working files preserved in {preserved}")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PipelineError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
