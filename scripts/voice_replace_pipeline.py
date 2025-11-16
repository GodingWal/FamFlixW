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
- Python packages: `faster-whisper` (recommended) or `openai-whisper`, plus `pydub`, `torch`/`torchaudio`, and `chatterbox-tts`.
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
import logging
import math
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, List, Optional

from pydub import AudioSegment
from pydub.effects import normalize, speedup  # Fixed: Import speedup


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

    print(f"[pipeline] Extracting audio from {input_video} -> {audio_output}")
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
    word_timestamps: bool = True,
) -> List[TranscriptSegment]:
    """Transcribe using the original openai-whisper package."""
    try:
        import whisper  # type: ignore
    except ImportError as exc:
        raise PipelineError(
            "openai-whisper is not installed. Install with `pip install openai-whisper`,"
            " or use --transcriber faster-whisper (recommended)."
        ) from exc

    print(f"[pipeline] Transcribing with openai-whisper model={model_name} device={device or 'auto'}")
    model = whisper.load_model(model_name, device=device)
    result = model.transcribe(
        str(audio_path),
        temperature=temperature,
        verbose=False,
        word_timestamps=word_timestamps,
        initial_prompt=None,
    )
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
    word_timestamps: bool = True,
    language: Optional[str] = None,
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

    print(f"[pipeline] Loading faster-whisper model={model_name} device={ct2_device} compute={ct2_compute}")
    model = WhisperModel(model_name, device=ct2_device, compute_type=ct2_compute)
    print("[pipeline] Model loaded. Starting transcription...")
    segments_iter, _info = model.transcribe(
        str(audio_path),
        beam_size=beam_size,
        word_timestamps=word_timestamps,
        language=language,
        vad_filter=True,
    )
    print("[pipeline] Processing segments...")
    segments_list = list(segments_iter)
    print(f"[pipeline] Transcription done: {len(segments_list)} segments")
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
    bin_path = binary_path
    if not bin_path:
        env_candidate = os.environ.get("WHISPER_CPP_BIN")
        if env_candidate:
            bin_path = Path(env_candidate)
    if not bin_path:
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

    timeout_sec = max(30, int(os.environ.get("WHISPER_CPP_TIMEOUT", "120")))
    try:
        result = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        fallback_cmd = list(cmd) + ["--beam-size", "1", "--best-of", "1"]
        fallback_timeout = max(30, timeout_sec // 2)
        try:
            result = subprocess.run(
                fallback_cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=fallback_timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise PipelineError(
                f"whisper.cpp timed out after {timeout_sec}s (fallback timeout {fallback_timeout}s)."
            ) from exc
        if result.returncode != 0:
            raise PipelineError(
                f"whisper.cpp fallback failed: {result.stderr.strip() or result.stdout.strip()}"
            )
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
    items: Any
    if isinstance(data, dict):
        items = data.get("segments") or data.get("result") or []
    else:
        items = data

    if isinstance(items, dict):
        items = items.get("segments", [])
    if isinstance(items, Iterable) and not isinstance(items, list):
        items = list(items)
    if not isinstance(items, list):
        items = []
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
    word_timestamps: bool = True,
    workdir: Optional[Path] = None,
    whisper_cpp_bin: Optional[Path] = None,
    whisper_cpp_model: Optional[Path] = None,
    whisper_cpp_threads: Optional[int] = None,
    language: Optional[str] = None,
) -> List[TranscriptSegment]:
    """Transcribe an audio file using the selected backend and return time-aligned segments."""

    backend = (transcriber or "auto").lower()
    print(f"[pipeline] Starting transcription via {backend} (whisper_model={model_name}, device={device or ct2_device or 'auto'})")
    if backend in ("faster-whisper", "faster_whisper"):
        return transcribe_with_faster_whisper(
            audio_path,
            model_name=model_name,
            device=ct2_device or device,
            compute_type=ct2_compute,
            beam_size=max(1, int(ct2_beam_size)),
            word_timestamps=word_timestamps,
            language=language,
        )
    elif backend == "whisper":
        return transcribe_with_openai_whisper(
            audio_path,
            model_name=model_name,
            device=device,
            temperature=temperature,
            word_timestamps=word_timestamps,
        )
    elif backend in ("whisper-cpp", "whisper_cpp"):
        env_bin = Path(os.environ.get("WHISPER_CPP_BIN", "")) if os.environ.get("WHISPER_CPP_BIN") else None  # Fixed: Safe Path
        env_model = Path(os.environ.get("WHISPER_CPP_MODEL", "")) if os.environ.get("WHISPER_CPP_MODEL") else None
        env_threads = os.environ.get("WHISPER_CPP_THREADS")
        cpp_bin = whisper_cpp_bin or env_bin
        cpp_model = whisper_cpp_model or env_model
        threads = whisper_cpp_threads or (int(env_threads) if env_threads and env_threads.isdigit() else None)  # Fixed: isdigit
        if not cpp_model:
            raise PipelineError("WHISPER_CPP_MODEL (or --whisper-cpp-model) is required for whisper-cpp backend")
        return transcribe_with_whisper_cpp(
            audio_path,
            model_path=cpp_model,
            binary_path=cpp_bin,
            workdir=workdir,
            language=language,
            threads=threads,
        )
    elif backend == "auto":
        # Try faster-whisper first, then fall back to other implementations
        try:
            return transcribe_with_faster_whisper(
                audio_path,
                model_name=model_name,
                device=ct2_device or device,
                compute_type=ct2_compute,
                beam_size=max(1, int(ct2_beam_size)),
                word_timestamps=word_timestamps,
            )
        except PipelineError:
            # Optionally try whisper.cpp if CLI args or env vars are configured
            env_bin = Path(os.environ.get("WHISPER_CPP_BIN", "")) if os.environ.get("WHISPER_CPP_BIN") else None  # Fixed: Safe
            env_model = Path(os.environ.get("WHISPER_CPP_MODEL", "")) if os.environ.get("WHISPER_CPP_MODEL") else None
            env_threads = os.environ.get("WHISPER_CPP_THREADS")
            cpp_bin = whisper_cpp_bin or env_bin
            cpp_model = whisper_cpp_model or env_model
            threads = whisper_cpp_threads or (int(env_threads) if env_threads and env_threads.isdigit() else None)
            if cpp_model:
                try:
                    return transcribe_with_whisper_cpp(
                        audio_path,
                        model_path=cpp_model,
                        binary_path=cpp_bin,
                        workdir=workdir,
                        language=language,
                        threads=threads,
                    )
                except PipelineError:
                    pass
            return transcribe_with_openai_whisper(
                audio_path,
                model_name=model_name,
                device=device,
                temperature=temperature,
                word_timestamps=word_timestamps,
            )
    else:
        raise PipelineError(
            f"Unsupported transcriber '{transcriber}'. Use one of: auto, faster-whisper, whisper, whisper-cpp."
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
    allow_fallback: bool = False,  # Added: Flag to tolerate beeps
    timeout_override: Optional[int] = None,
    verbose: bool = False,  # Added: Propagate verbose
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
    if verbose:  # Added: Propagate
        cmd.append("--verbose")

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
        # Fallback: retry with adaptive smaller/safer settings (text len-based)
        text_len = max(1, len(text.strip()))
        fallback_steps = max(6, min(20, int(0.3 * text_len)))  # Adaptive: ~0.3 steps/char, cap 20
        fallback_tokens = max(16, min(64, int(0.5 * text_len)))
        fallback = list(cmd)
        if "--steps" in fallback:
            i = fallback.index("--steps")
            if i >= 0 and i + 1 < len(fallback):
                fallback[i + 1] = str(fallback_steps)
        else:
            fallback.extend(["--steps", str(fallback_steps)])
        if "--max-new-tokens" in fallback:
            i = fallback.index("--max-new-tokens")
            if i >= 0 and i + 1 < len(fallback):
                fallback[i + 1] = str(fallback_tokens)
        else:
            fallback.extend(["--max-new-tokens", str(fallback_tokens)])
        try:
            result = subprocess.run(fallback, check=False, capture_output=True, text=True, env=env, timeout=max(90, timeout_sec // 2))
        except subprocess.TimeoutExpired as e2:
            raise PipelineError(f"Chatterbox CLI timed out: initial={timeout_sec}s, fallback={max(90, timeout_sec // 2)}s") from e2
    if result.returncode != 0:
        raise PipelineError(f"Chatterbox CLI failed: {result.stderr or result.stdout}")
    # Parse JSON line to report whether the prompt was used and check for fallback
    try:
        last_line = (result.stdout or "").strip().splitlines()[-1]
        meta = json.loads(last_line) if last_line else {}
        used = meta.get("used_prompt_arg")
        norm = meta.get("normalized_prompt_path")
        note = meta.get("note")
        if used is not None:
            logging.info(f"[chatterbox] used_prompt_arg={used} normalized_prompt_path={norm}")
        if note == "fallback_beep_audio" and not allow_fallback:  # Fixed: Detect and raise on beep
            raise PipelineError(f"Chatterbox fell back to beep audio (note: {note}). Check CLI verbose output.")
    except json.JSONDecodeError:
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


def stretch_segment(input_path: Path, output_path: Path, target_duration: float) -> None:
    """Time-stretch an audio clip so that its duration matches the target duration using pydub."""

    current_duration = segment_audio_duration(input_path)
    if current_duration <= 0:
        raise PipelineError(f"Segment {input_path} has zero/negative duration; cannot stretch.")

    target_duration = max(0.1, target_duration)  # Min 100ms
    speed = current_duration / target_duration
    if speed == 1.0:
        # No-op: copy
        run_command(["cp", str(input_path), str(output_path)])
        return

    clip = AudioSegment.from_file(input_path)
    # Use speedup (preserves pitch better than atempo)
    stretched = speedup(clip, playback_speed=speed, chunk_size=150, crossfade=25)  # Tuned for naturalness
    stretched.export(output_path, format="wav")


def assemble_segments(segments: Iterable[GeneratedSegment], output_path: Path) -> None:
    """Overlay the generated dialogue segments into a single audio track with gap filling."""

    ordered = sorted(segments, key=lambda seg: seg.transcript.start)
    if not ordered:
        raise PipelineError("No generated segments provided for assembly.")

    # Compute total duration with padding
    total_duration_ms = int(math.ceil(ordered[-1].transcript.end * 1000)) + 1000  # +1s tail
    final_audio = AudioSegment.silent(duration=total_duration_ms)

    prev_end_ms = 0
    for seg in ordered:
        # Insert silence for gaps > 100ms
        gap_start = prev_end_ms
        gap_end = int(seg.transcript.start * 1000)
        if gap_end - gap_start > 100:
            silence = AudioSegment.silent(duration=gap_end - gap_start)
            final_audio = final_audio.overlay(silence, position=gap_start)  # Explicit, though silent base

        clip = AudioSegment.from_file(seg.audio_path, format="wav")
        clip = clip.fade_in(50).fade_out(50)
        position_ms = int(seg.transcript.start * 1000)
        final_audio = final_audio.overlay(clip, position=position_ms)
        prev_end_ms = max(prev_end_ms, position_ms + len(clip))

    # Normalize with compression to avoid clipping
    final_audio = normalize(final_audio)
    # Added: Light compression
    from pydub.effects import compress_dynamic_range  # Assumes pydub 0.25+
    final_audio = compress_dynamic_range(final_audio, threshold=-20.0, ratio=4.0, attack=5.0, release=50.0)
    final_audio.export(output_path, format="wav", bitrate="192k")


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
    allow_fallback: bool = False,  # Added: Propagate
    verbose: bool = False,  # Added: Propagate
) -> List[GeneratedSegment]:
    """Generate and time-stretch Chatterbox audio clips for each transcript segment."""

    def split_long_segment(segment: TranscriptSegment, max_duration: float = 15.0) -> List[TranscriptSegment]:
        if segment.duration <= max_duration:
            return [segment]

        words = segment.text.split()
        if not words:
            return [segment]

        words_per_sec = max(len(words) / max(segment.duration, 1e-6), 1.0)
        chunk_word_count = max(int(words_per_sec * max_duration), 1)

        sub_segments: List[TranscriptSegment] = []
        start = segment.start
        idx = 0
        while idx < len(words):
            end = min(start + max_duration, segment.end)
            chunk_words = words[idx : idx + chunk_word_count]
            sub_segments.append(
                TranscriptSegment(
                    start=start,
                    end=end,
                    text=" ".join(chunk_words).strip(),
                )
            )
            start = end
            idx += chunk_word_count
        return sub_segments

    all_segments: List[TranscriptSegment] = []
    for seg in segments:
        all_segments.extend(split_long_segment(seg))

    generated: List[GeneratedSegment] = []
    for index, segment in enumerate(all_segments):
        print(f"[pipeline] Synthesizing segment {index + 1}/{len(all_segments)}: '{segment.text[:40]}' duration={segment.duration:.2f}s")
        raw_clip = workdir / f"segment_{index:04d}_raw.wav"
        stretched_clip = workdir / f"segment_{index:04d}_aligned.wav"

        # Adaptive timeout: longer for longer text/first call
        text_len = max(1, len(segment.text.strip()))
        base_timeout = int(os.environ.get("CHATTERBOX_TIMEOUT", "120"))
        per_call_timeout = max(base_timeout, int(1.5 * text_len)) if index == 0 else base_timeout

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
                allow_fallback=allow_fallback,
                timeout_override=per_call_timeout,
                verbose=verbose,
            )
        except PipelineError as exc:
            if allow_fallback:
                logging.warning(f"Using beep fallback for segment {index}: {exc}")
                try:
                    synthesize_beep(raw_clip, duration=segment.duration or 0.5)
                except Exception as beep_exc:
                    raise PipelineError(f"Beep fallback failed: {beep_exc}; original: {exc}") from exc
            else:
                raise

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
        default=os.environ.get("WHISPER_MODEL", "tiny"),
        help="Whisper model name (tiny, base, small, medium, large, large-v2, ...) (tiny by default for speed)",
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
        choices=["auto", "faster-whisper", "whisper", "whisper-cpp", "whisper_cpp"],
        default=os.environ.get("TRANSCRIBER", "auto"),
        help="Transcription backend. Default 'auto' tries faster-whisper, optional whisper.cpp, then openai-whisper.",
    )
    parser.add_argument(
        "--ct2-device",
        choices=["cpu", "cuda"],
        default=os.environ.get("WHISPER_CT2_DEVICE", "cpu"),
        help="CTranslate2 device for faster-whisper.",
    )
    parser.add_argument(
        "--ct2-compute",
        default=os.environ.get("WHISPER_CT2_COMPUTE", "int8"),
        help="CTranslate2 compute type for faster-whisper (e.g. int8, int8_float16, float16, float32).",
    )
    parser.add_argument(
        "--ct2-beam-size",
        type=int,
        default=int(os.environ.get("WHISPER_CT2_BEAM", "1")),
        help="Beam size for faster-whisper decoding.",
    )
    parser.add_argument(
        "--whisper-cpp-bin",
        type=Path,
        default=None,
        help="Path to whisper.cpp binary (overrides WHISPER_CPP_BIN)",
    )
    parser.add_argument(
        "--whisper-cpp-model",
        type=Path,
        default=None,
        help="Path to whisper.cpp ggml model (overrides WHISPER_CPP_MODEL)",
    )
    parser.add_argument(
        "--whisper-cpp-threads",
        type=int,
        default=None,
        help="Thread count for whisper.cpp (overrides WHISPER_CPP_THREADS)",
    )
    parser.add_argument(
        "--word-timestamps",
        dest="word_timestamps",
        action="store_true",
        default=True,
        help="Enable word-level timestamps when transcribing (default: enabled)",
    )
    parser.add_argument(
        "--no-word-timestamps",
        dest="word_timestamps",
        action="store_false",
        help="Disable word-level timestamps (not recommended for long-form dubbing)",
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
    parser.add_argument("--language", default=os.environ.get("WHISPER_LANGUAGE", "en"), help="Language id for multilingual model (e.g. en, fr, zh)")
    parser.add_argument("--exaggeration", type=float, default=None, help="Emotion/exaggeration control (0..1)")
    parser.add_argument("--cfg-weight", dest="cfg_weight", type=float, default=None, help="Guidance weight (0..1)")
    parser.add_argument("--allow-fallback", action="store_true", help="Allow beep fallbacks (default: error on fallback)")  # Added
    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging in pipeline and CLI")  # Added
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

    if not isinstance(data, list):
        raise PipelineError(f"Transcript JSON must be a list of segments: {path}")

    segments: List[TranscriptSegment] = []
    for i, item in enumerate(data):
        try:
            # Added: Validate keys/types
            start = float(item.get("start", 0.0))
            end = float(item.get("end", start))  # Default to start if missing
            if end < start:
                raise ValueError("end < start")
            text = str(item.get("text", "")).strip()
            if text:
                segments.append(TranscriptSegment(start=start, end=end, text=text))
        except (KeyError, TypeError, ValueError) as exc:
            raise PipelineError(f"Invalid transcript entry at index {i}: {item}") from exc

    # Added: Check monotonicity
    for i in range(1, len(segments)):
        if segments[i].start < segments[i-1].end:
            logging.warning(f"Overlapping segments at {i}: adjust manually if needed")

    return segments


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    # Setup logging
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, stream=sys.stderr, format="%(levelname)s: %(message)s")

    if not args.input_video.exists():
        raise PipelineError(f"Input video {args.input_video} does not exist.")
    if not args.audio_prompt.exists():
        raise PipelineError(f"Audio prompt {args.audio_prompt} does not exist.")

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
                word_timestamps=args.word_timestamps,
                whisper_cpp_bin=args.whisper_cpp_bin,
                whisper_cpp_model=args.whisper_cpp_model,
                whisper_cpp_threads=args.whisper_cpp_threads,
                language=args.language,
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
            allow_fallback=args.allow_fallback,
            verbose=args.verbose,
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
                    shutil.copy2(str(item), str(destination))  # Fixed: Use shutil.copy2
                elif item.is_dir():
                    shutil.copytree(str(item), str(destination), dirs_exist_ok=True)
            print(f"Working files preserved in {preserved}")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except PipelineError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
