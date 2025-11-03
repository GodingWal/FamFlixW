"""Utility script for generating clean transcripts from admin-uploaded videos."""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

try:
    import whisper
    from whisper.utils import write_srt
except ImportError as exc:  # pragma: no cover - optional dependency
    raise SystemExit(
        "The `openai-whisper` package is required for transcription.\n"
        "Install it with `pip install openai-whisper`."
    ) from exc

try:
    from pydub import AudioSegment
except ImportError as exc:  # pragma: no cover - optional dependency
    raise SystemExit(
        "The `pydub` package is required for audio preprocessing.\n"
        "Install it with `pip install pydub`."
    ) from exc


@dataclass
class TranscriptionArtifacts:
    """Paths to the key files produced by the pipeline."""

    original_audio: Path
    denoised_audio: Path
    clean_audio: Path
    transcript_json: Path
    transcript_srt: Path


class PipelineError(RuntimeError):
    """Raised when an external tool fails."""


# ---------------------------------------------------------------------------
# Shell helpers
# ---------------------------------------------------------------------------

def run_command(command: List[str], *, cwd: Optional[Path] = None) -> None:
    """Execute a shell command and raise a helpful error message on failure."""

    result = subprocess.run(command, cwd=cwd, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout
        raise PipelineError(f"Command {' '.join(command)} failed: {stderr}")


# ---------------------------------------------------------------------------
# Audio processing
# ---------------------------------------------------------------------------

def extract_audio(input_video: Path, output_wav: Path) -> None:
    """Extract the highest-quality audio stream from the video."""

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
            str(output_wav),
        ]
    )


def denoise_audio(input_wav: Path, output_wav: Path, *, noise_floor: float) -> None:
    """Apply ffmpeg's frequency-domain denoiser to reduce steady background hum."""

    # afftdn works well for broadband noise and does not require external models.
    audio_filter = f"afftdn=nf={noise_floor}"
    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_wav),
            "-af",
            audio_filter,
            str(output_wav),
        ]
    )


def normalize_audio(input_wav: Path, output_wav: Path, *, target_peak_dbfs: float) -> None:
    """Normalise the audio to the requested peak level using pydub."""

    audio = AudioSegment.from_file(input_wav)
    peak = audio.max_dBFS
    # Guard against silence which reports -inf
    if peak == float("-inf"):
        raise PipelineError("The extracted audio is silent; cannot normalise.")
    gain = target_peak_dbfs - peak
    normalized = audio.apply_gain(gain)
    normalized.export(output_wav, format="wav")


def trim_silence(
    input_wav: Path,
    output_wav: Path,
    *,
    threshold: float,
    min_silence_ms: int,
    keep_silence_ms: int,
) -> None:
    """Trim leading and trailing silence using ffmpeg's silenceremove."""

    # ffmpeg's silenceremove expects negative dBFS thresholds.
    filter_expr = (
        "silenceremove="
        f"start_periods=1:start_threshold={threshold}dB:start_silence={min_silence_ms / 1000}:"
        f"stop_periods=1:stop_threshold={threshold}dB:stop_silence={min_silence_ms / 1000}:"
        f"leave_silence={keep_silence_ms / 1000}"
    )
    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(input_wav),
            "-af",
            filter_expr,
            str(output_wav),
        ]
    )


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

def transcribe(
    audio_path: Path,
    *,
    model_name: str,
    device: Optional[str],
    temperature: float,
    word_timestamps: bool,
) -> dict:
    """Run Whisper locally and return the full transcription payload."""

    model = whisper.load_model(model_name, device=device)
    result = model.transcribe(
        str(audio_path),
        temperature=temperature,
        word_timestamps=word_timestamps,
        verbose=False,
    )
    if not result.get("segments"):
        raise PipelineError("Whisper did not return any segments; check the audio quality.")
    return result


def write_transcripts(segments: Iterable[dict], json_path: Path, srt_path: Path) -> None:
    """Persist Whisper segments as JSON and SRT files."""

    segment_list = list(segments)

    with json_path.open("w", encoding="utf-8") as json_file:
        json.dump(segment_list, json_file, indent=2, ensure_ascii=False)

    with srt_path.open("w", encoding="utf-8") as srt_file:
        write_srt(segment_list, file=srt_file)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a cleaned WAV and timestamped transcript entirely offline."
    )
    parser.add_argument("--input-video", type=Path, required=True, help="Path to the video file")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Directory for intermediate artefacts (defaults to alongside the input video)",
    )
    parser.add_argument(
        "--model",
        default="medium",
        help="Whisper model name to load (e.g. tiny, base, small, medium, large)",
    )
    parser.add_argument(
        "--device",
        default="cpu",
        help="Torch device to use for Whisper (cpu, cuda, etc.)",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="Sampling temperature for Whisper (0 keeps deterministic output)",
    )
    parser.add_argument(
        "--target-peak",
        type=float,
        default=-3.0,
        help="Peak loudness in dBFS after normalisation",
    )
    parser.add_argument(
        "--noise-floor",
        type=float,
        default=-25.0,
        help="Noise floor in dB for the afftdn denoiser (more negative preserves more ambience)",
    )
    parser.add_argument(
        "--trim-silence",
        action="store_true",
        help="Enable trimming of leading/trailing silences before transcription",
    )
    parser.add_argument(
        "--silence-threshold",
        type=float,
        default=-35.0,
        help="Silence threshold in dBFS when trimming (use negative values)",
    )
    parser.add_argument(
        "--min-silence-ms",
        type=int,
        default=700,
        help="Minimum silence duration (milliseconds) required before trimming",
    )
    parser.add_argument(
        "--keep-silence-ms",
        type=int,
        default=200,
        help="Silence (milliseconds) to retain at segment edges after trimming",
    )
    parser.add_argument(
        "--word-timestamps",
        action="store_true",
        help="Ask Whisper to include word-level timestamps in the JSON output",
    )
    parser.add_argument(
        "--skip-denoise",
        action="store_true",
        help="Skip the afftdn denoising stage",
    )
    parser.add_argument(
        "--skip-transcription",
        action="store_true",
        help="Stop after producing clean_audio.wav without running Whisper",
    )
    return parser.parse_args(argv)


def build_output_paths(video_path: Path, output_dir: Optional[Path]) -> TranscriptionArtifacts:
    if output_dir is None:
        output_dir = video_path.with_suffix("")
    output_dir.mkdir(parents=True, exist_ok=True)
    return TranscriptionArtifacts(
        original_audio=output_dir / "original_audio.wav",
        denoised_audio=output_dir / "denoised_audio.wav",
        clean_audio=output_dir / "clean_audio.wav",
        transcript_json=output_dir / "clean_audio.json",
        transcript_srt=output_dir / "clean_audio.srt",
    )


def main(argv: Optional[List[str]] = None) -> None:
    args = parse_args(argv)
    video_path: Path = args.input_video
    if not video_path.exists():
        raise SystemExit(f"Input video {video_path} does not exist")

    artefacts = build_output_paths(video_path, args.output_dir)

    print(f"[pipeline] Extracting audio -> {artefacts.original_audio}")
    extract_audio(video_path, artefacts.original_audio)

    current_audio = artefacts.original_audio

    if args.skip_denoise:
        print("[pipeline] Skipping denoise stage by request")
    else:
        print(f"[pipeline] Denoising audio -> {artefacts.denoised_audio}")
        denoise_audio(current_audio, artefacts.denoised_audio, noise_floor=args.noise_floor)
        current_audio = artefacts.denoised_audio

    print(f"[pipeline] Normalising audio to {args.target_peak} dBFS -> {artefacts.clean_audio}")
    normalize_audio(current_audio, artefacts.clean_audio, target_peak_dbfs=args.target_peak)
    current_audio = artefacts.clean_audio

    if args.trim_silence:
        trimmed_path = artefacts.clean_audio.with_name("clean_audio_trimmed.wav")
        print(f"[pipeline] Trimming silence -> {trimmed_path}")
        trim_silence(
            current_audio,
            trimmed_path,
            threshold=args.silence_threshold,
            min_silence_ms=args.min_silence_ms,
            keep_silence_ms=args.keep_silence_ms,
        )
        current_audio = trimmed_path

    if args.skip_transcription:
        print("[pipeline] Transcription skipped; pipeline finished after audio prep")
        return

    print(f"[pipeline] Transcribing with Whisper model '{args.model}' on {args.device}")
    result = transcribe(
        current_audio,
        model_name=args.model,
        device=args.device,
        temperature=args.temperature,
        word_timestamps=args.word_timestamps,
    )
    segments = result["segments"]

    print(f"[pipeline] Writing transcripts -> {artefacts.transcript_json}, {artefacts.transcript_srt}")
    write_transcripts(segments, artefacts.transcript_json, artefacts.transcript_srt)

    print("[pipeline] Completed successfully")


if __name__ == "__main__":
    main()
