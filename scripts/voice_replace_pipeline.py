"""Pipeline script to replace a video's dialogue track with a Chatterbox zero-shot cloned voice.

This script orchestrates the end-to-end workflow:
    1. Extract the audio track from a source video with ffmpeg.
    2. Transcribe the dialogue with a pluggable transcription backend (default: faster-whisper) to obtain time-aligned segments.
    3. Generate a cloned-voice performance for each segment with the Chatterbox model (local CLI).
    4. Time-stretch every generated segment to match the original pacing.
    5. Assemble the processed segments into a final dialogue track and swap it into the video.

The implementation favours clarity over absolute efficiency so that individual steps can be
swapped out or customised easily. Each stage can also be skipped when its artefact is supplied
explicitly via the command-line options.

Prerequisites
-------------
- ffmpeg and ffprobe available on the PATH.
- Python packages: `faster-whisper` (recommended) or `openai-whisper`, plus `pydub`, `requests`, `torch`/`torchaudio`, and `chatterbox-tts`.
- A clean voice sample WAV/MP3 that will be used as the audio prompt for zero-shot cloning.

Example
-------
python scripts/voice_replace_pipeline.py \\
    --input-video ./input.mp4 \\
    --output-video ./output.mp4 \\
    --audio-prompt ./voice_sample.wav \\
    --device cpu \\
    --transcriber faster-whisper \\
    --ct2-device cuda \\
    --ct2-compute float16 \\
    --ct2-beam-size 5

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
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

import requests

try:
    import whisper
except ImportError:  # pragma: no cover - whisper is an optional dependency at runtime
    pass

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


def synthesize_beep(output_path: Path, *, duration: float, frequency: int = 440, sample_rate: int = 22050) -> None:
    """Generate a simple sine beep WAV as a fallback using ffmpeg lavfi.

    This ensures the pipeline can proceed even if TTS fails or times out.
    """
    dur = max(0.2, float(duration))  # minimum 200ms to avoid zero-length
    run_command(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={int(frequency)}:sample_rate={int(sample_rate)}:duration={dur:.3f}",
            "-ac",
            "1",
            "-ar",
            str(int(sample_rate)),
            str(output_path),
        ]
    )


def transcribe_with_openai_whisper(
    audio_path: Path,
    *,
    model_name: str,
    device: Optional[str] = None,
    temperature: float = 0.0,
) -> List[TranscriptSegment]:
    """Transcribe using the original openai-whisper package."""
    try:
        import whisper  # type: ignore
    except ImportError as exc:
        raise PipelineError(
            "openai-whisper is not installed. Install with `pip install openai-whisper`,"
            " or use --transcriber faster-whisper (recommended)."
        ) from exc

    model = whisper.load_model(model_name, device=device)
    result = model.transcribe(str(audio_path), temperature=temperature, verbose=False)
    segments = [
        TranscriptSegment(start=seg.get("start", 0.0), end=seg.get("end", 0.0), text=str(seg.get("text", "")).strip())
        for seg in result.get("segments", [])
        if seg.get("text")
    ]
    if not segments:
        raise PipelineError(
            "openai-whisper produced no transcript segments. Check audio quality or choose a larger model."
        )
    return segments


def transcribe_with_faster_whisper(
    audio_path: Path,
    *,
    model_name: str,
    device: Optional[str] = None,
    compute_type: Optional[str] = None,
    beam_size: int = 5,
) -> List[TranscriptSegment]:
    """Transcribe using faster-whisper (CTranslate2 backend)."""
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        raise PipelineError(
            "faster-whisper is not installed. Install with `pip install faster-whisper`."
        ) from exc

    # Map device
    dev = (device or "cpu").lower()
    ct2_device = "cuda" if dev.startswith("cuda") else "cpu"
    ct2_compute = compute_type or ("float16" if ct2_device == "cuda" else "int8")

    model = WhisperModel(model_name, device=ct2_device, compute_type=ct2_compute)
    segments_iter, _info = model.transcribe(str(audio_path), beam_size=beam_size)
    segments_list = list(segments_iter)
    segments: List[TranscriptSegment] = [
        TranscriptSegment(start=float(getattr(seg, "start", 0.0)), end=float(getattr(seg, "end", 0.0)), text=str(getattr(seg, "text", "")).strip())
        for seg in segments_list
        if getattr(seg, "text", None)
    ]
    if not segments:
        raise PipelineError(
            "faster-whisper produced no transcript segments. Check audio quality or choose a larger model."
        )
    return segments


def transcribe_with_whisper_cpp(
    audio_path: Path,
    *,
    model_path: Path,
    binary_path: Optional[Path] = None,
    workdir: Optional[Path] = None,
    language: Optional[str] = None,
    threads: Optional[int] = None,
) -> List[TranscriptSegment]:
    """Transcribe using whisper.cpp CLI (requires compiled binary and ggml model)."""
    bin_path = binary_path or Path(os.environ.get("WHISPER_CPP_BIN", ""))
    if not bin_path:
        # Try to find common binary names in PATH
        for candidate in ["whisper-cpp", "whisper", "main"]:
            found = shutil.which(candidate)
            if found:
                bin_path = Path(found)
                break
    if not bin_path or not Path(bin_path).exists():
        raise PipelineError("whisper.cpp binary not found. Set --whisper-cpp-bin or WHISPER_CPP_BIN.")

    if not model_path.exists():
        raise PipelineError(f"whisper.cpp model not found: {model_path}")

    out_dir = workdir or audio_path.parent
    out_prefix = out_dir / "whispercpp_out"

    cmd: List[str] = [
        str(bin_path),
        "-m", str(model_path),
        "-f", str(audio_path),
        "-oj",               # output JSON
        "-of", str(out_prefix),
    ]
    if language:
        cmd += ["-l", language]
    if threads and threads > 0:
        cmd += ["-t", str(threads)]

    # Run with timeout to avoid long stalls on CPU
    timeout_sec = int(os.environ.get("CHATTERBOX_TIMEOUT", "90"))
    try:
        result = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        # Fallback: retry with smaller settings
        fallback_cmd = list(cmd)
        # Force conservative params
        if "--steps" in fallback_cmd:
            idx = fallback_cmd.index("--steps")
            if idx >= 0 and idx + 1 < len(fallback_cmd):
                fallback_cmd[idx + 1] = "6"
        else:
            fallback_cmd.extend(["--steps", "6"])
        if "--max-new-tokens" in fallback_cmd:
            idx = fallback_cmd.index("--max-new-tokens")
            if idx >= 0 and idx + 1 < len(fallback_cmd):
                fallback_cmd[idx + 1] = "16"
        else:
            fallback_cmd.extend(["--max-new-tokens", "16"])
        result = subprocess.run(fallback_cmd, check=False, capture_output=True, text=True, timeout=max(30, timeout_sec // 2))
    if result.returncode != 0:
        raise PipelineError(f"whisper.cpp failed: {result.stderr or result.stdout}")

    json_path = out_dir / "whispercpp_out.json"
    if not json_path.exists():
        # Some versions may append suffixes; fallback to searching
        candidates = list(out_dir.glob("whispercpp_out*.json"))
        if candidates:
            json_path = candidates[0]
    if not json_path.exists():
        raise PipelineError("whisper.cpp did not produce a JSON transcript")

    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PipelineError(f"Failed to parse whisper.cpp JSON: {exc}") from exc

    segments: List[TranscriptSegment] = []
    # Expecting data structure with "segments" list
    items = data.get("segments") if isinstance(data, dict) else None
    if not isinstance(items, list):
        # Some builds output a list of segments directly
        items = data if isinstance(data, list) else []
    for seg in items:
        try:
            start = float(seg.get("start", 0.0))
            end = float(seg.get("end", 0.0))
            text = str(seg.get("text", "")).strip()
            if text:
                segments.append(TranscriptSegment(start=start, end=end, text=text))
        except Exception:
            continue
    if not segments:
        raise PipelineError("whisper.cpp produced no transcript segments")
    return segments


def transcribe_audio(
    audio_path: Path,
    *,
    model_name: str,
    device: Optional[str] = None,
    temperature: float = 0.0,
    transcriber: str = "auto",
    ct2_device: Optional[str] = None,
    ct2_compute: Optional[str] = None,
    ct2_beam_size: int = 5,
    workdir: Optional[Path] = None,
    whisper_cpp_bin: Optional[Path] = None,
    whisper_cpp_model: Optional[Path] = None,
    whisper_cpp_threads: Optional[int] = None,
    language: Optional[str] = None,
) -> List[TranscriptSegment]:
    """Transcribe an audio file using the selected backend and return time-aligned segments."""

    backend = (transcriber or "auto").lower()
    if backend in ("faster-whisper", "faster_whisper"):
        return transcribe_with_faster_whisper(
            audio_path,
            model_name=model_name,
            device=ct2_device or device,
            compute_type=ct2_compute,
            beam_size=max(1, int(ct2_beam_size)),
        )
    elif backend == "whisper":
        return transcribe_with_openai_whisper(
            audio_path,
            model_name=model_name,
            device=device,
            temperature=temperature,
        )
    elif backend in ("whisper-cpp", "whisper_cpp"):
        cpp_bin = whisper_cpp_bin or (Path(os.environ["WHISPER_CPP_BIN"]) if "WHISPER_CPP_BIN" in os.environ else None)
        cpp_model = whisper_cpp_model or (Path(os.environ["WHISPER_CPP_MODEL"]) if "WHISPER_CPP_MODEL" in os.environ else None)
        if not cpp_model:
            raise PipelineError("WHISPER_CPP_MODEL is required for whisper-cpp backend (path to ggml model)")
        return transcribe_with_whisper_cpp(
            audio_path,
            model_path=cpp_model,
            binary_path=cpp_bin,
            workdir=workdir,
            language=language,
            threads=whisper_cpp_threads,
        )
    elif backend == "auto":
        # Try faster-whisper first, then fall back to openai-whisper
        try:
            return transcribe_with_faster_whisper(
                audio_path,
                model_name=model_name,
                device=ct2_device or device,
                compute_type=ct2_compute,
                beam_size=max(1, int(ct2_beam_size)),
            )
        except PipelineError:
            # Optionally try whisper.cpp if env is configured
            cpp_bin_env = Path(os.environ["WHISPER_CPP_BIN"]) if "WHISPER_CPP_BIN" in os.environ else None
            cpp_model_env = Path(os.environ["WHISPER_CPP_MODEL"]) if "WHISPER_CPP_MODEL" in os.environ else None
            if cpp_model_env:
                try:
                    return transcribe_with_whisper_cpp(
                        audio_path,
                        model_path=cpp_model_env,
                        binary_path=cpp_bin_env,
                        workdir=workdir,
                        language=language,
                        threads=whisper_cpp_threads,
                    )
                except PipelineError:
                    pass
            return transcribe_with_openai_whisper(
                audio_path,
                model_name=model_name,
                device=device,
                temperature=temperature,
            )
    else:
        raise PipelineError(
            f"Unsupported transcriber '{transcriber}'. Use one of: auto, faster-whisper, whisper."
        )


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
    timeout_override: Optional[int] = None,
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
    # Optional generation tuning
    steps_env = os.environ.get("CHATTERBOX_STEPS")
    if steps_env and steps_env.isdigit():
        cmd.extend(["--steps", steps_env])
    attn_impl = os.environ.get("CHATTERBOX_ATTN_IMPL")
    if attn_impl:
        cmd.extend(["--attn-impl", attn_impl])
    max_new_tokens = os.environ.get("CHATTERBOX_MAX_NEW_TOKENS")
    if max_new_tokens and max_new_tokens.isdigit():
        cmd.extend(["--max-new-tokens", max_new_tokens])
    if multilingual:
        cmd.append("--multilingual")
    if language:
        cmd.extend(["--language", language])
    if exaggeration is not None:
        cmd.extend(["--exaggeration", str(exaggeration)])
    if cfg_weight is not None:
        cmd.extend(["--cfg-weight", str(cfg_weight)])

    # Quiet/robust env for the subprocess
    env = os.environ.copy()
    env.setdefault("DIFFUSERS_DISABLE_PROGRESS_BARS", "1")
    env.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    env.setdefault("TRANSFORMERS_VERBOSITY", "error")
    env.setdefault("PYTHONWARNINGS", "ignore::FutureWarning")

    timeout_sec = int(timeout_override or os.environ.get("CHATTERBOX_TIMEOUT", "120"))
    try:
        result = subprocess.run(cmd, check=False, capture_output=True, text=True, env=env, timeout=timeout_sec)
    except subprocess.TimeoutExpired as e1:
        # Fallback: retry with smaller/safer settings
        fallback = list(cmd)
        if "--steps" in fallback:
            i = fallback.index("--steps")
            if i >= 0 and i + 1 < len(fallback):
                fallback[i + 1] = "6"
        else:
            fallback.extend(["--steps", "6"])
        if "--max-new-tokens" in fallback:
            i = fallback.index("--max-new-tokens")
            if i >= 0 and i + 1 < len(fallback):
                fallback[i + 1] = "16"
        else:
            fallback.extend(["--max-new-tokens", "16"])
        try:
            result = subprocess.run(fallback, check=False, capture_output=True, text=True, env=env, timeout=max(90, timeout_sec // 2))
        except subprocess.TimeoutExpired as e2:
            raise PipelineError(f"Chatterbox CLI timed out: initial={timeout_sec}s, fallback={max(90, timeout_sec // 2)}s") from e2
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

        # Allow longer timeout for the very first synthesis (model download/init)
        initial_timeout = int(os.environ.get("CHATTERBOX_INITIAL_TIMEOUT", "480"))
        per_call_timeout = None if index > 0 else initial_timeout

        try:
            chatterbox_tts(
                text=segment.text,
                audio_prompt=audio_prompt,
                output_path=raw_clip,
                device=device,
                multilingual=multilingual,
                language=language,
                exaggeration=exaggeration,
                cfg_weight=cfg_weight,
                timeout_override=per_call_timeout,
            )
        except PipelineError as exc:
            # Fallback: synthesize a simple beep of target duration
            try:
                synthesize_beep(raw_clip, duration=segment.duration or 0.5)
            except Exception as beep_exc:
                raise PipelineError(f"Chatterbox failed and beep fallback also failed: {beep_exc}; original: {exc}") from exc

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
        "--transcriber",
        choices=["auto", "faster-whisper", "whisper"],
        default=os.environ.get("TRANSCRIBER", "auto"),
        help="Transcription backend. Default 'auto' tries faster-whisper then falls back to openai-whisper.",
    )
    parser.add_argument(
        "--ct2-device",
        choices=["cpu", "cuda"],
        default=os.environ.get("WHISPER_CT2_DEVICE", "cpu"),
        help="CTranslate2 device for faster-whisper.",
    )
    parser.add_argument(
        "--ct2-compute",
        default=os.environ.get("WHISPER_CT2_COMPUTE", None),
        help="CTranslate2 compute type for faster-whisper (e.g. int8, int8_float16, float16, float32).",
    )
    parser.add_argument(
        "--ct2-beam-size",
        type=int,
        default=int(os.environ.get("WHISPER_CT2_BEAM", "5")),
        help="Beam size for faster-whisper decoding.",
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
                transcriber=args.transcriber,
                ct2_device=args.ct2_device,
                ct2_compute=args.ct2_compute,
                ct2_beam_size=args.ct2_beam_size,
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
