#!/usr/bin/env python3
"""
CLI wrapper for Resemble AI's Chatterbox TTS.

Usage example:
  python scripts/chatterbox_tts.py \
    --text "Hello world" \
    --out /tmp/out.wav \
    --audio-prompt /path/to/voice_sample.wav \
    --device cpu \
    --language en \
    --multilingual

This script prints a single JSON line to stdout with fields:
  {"out_path": "...", "duration_sec": <float>, "sr": <int>}
"""
from __future__ import annotations

import argparse
import json
import sys
import inspect
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    try:
        import torch
        import torchaudio as ta
        import torchaudio.functional as TAF
        from chatterbox.tts import ChatterboxTTS
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    except Exception as exc:
        print(json.dumps({
            "error": f"Missing dependencies: {exc}. Install with: pip install chatterbox-tts torch torchaudio"
        }), file=sys.stdout, flush=True)
        return 2

    parser = argparse.ArgumentParser(description="Chatterbox TTS CLI")
    parser.add_argument("--text", required=True, help="Text to synthesize")
    parser.add_argument("--out", required=True, type=Path, help="Output WAV path")
    parser.add_argument("--speaker-wav", dest="speaker_wav", type=Path, help="Reference voice WAV path for cloning")
    parser.add_argument("--device", default="cpu", help="torch device: cpu or cuda")
    parser.add_argument("--language", default="en", help="Language id for multilingual model (e.g. en, fr, zh)")
    parser.add_argument("--multilingual", action="store_true", help="Use multilingual model")
    parser.add_argument("--exaggeration", type=float, default=0.5, help="Emotion/exaggeration control (0..1)")
    parser.add_argument("--cfg-weight", dest="cfg_weight", type=float, default=0.5, help="Guidance weight (0..1)")

    args = parser.parse_args(argv)

    device = args.device
    try:
        if device.startswith("cuda") and not torch.cuda.is_available():
            device = "cpu"
    except Exception:
        device = "cpu"

    # Load model
    if args.multilingual:
        model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    else:
        model = ChatterboxTTS.from_pretrained(device=device)

    # Prepare prompt normalization if provided
    normalized_prompt_path: str | None = None
    prompt_wav = None
    prompt_sr = None
    if args.speaker_wav:
        speaker_wav_path = Path(args.speaker_wav)
        if not speaker_wav_path.exists():
            print(json.dumps({
                "error": f"Speaker WAV not found: {speaker_wav_path}"
            }), file=sys.stdout, flush=True)
            return 3

        # Load prompt
        try:
            wav_in, sr_in = ta.load(str(speaker_wav_path))
            # Convert to mono if needed
            if wav_in.dim() == 2 and wav_in.size(0) > 1:
                wav_in = wav_in.mean(dim=0, keepdim=True)
            target_sr = int(getattr(model, "sr", sr_in))
            if target_sr <= 0:
                target_sr = sr_in
            if int(sr_in) != target_sr:
                wav_in = TAF.resample(wav_in, int(sr_in), target_sr)
                sr_in = target_sr

            # Save a normalized WAV next to output
            out_dir = args.out.parent
            out_dir.mkdir(parents=True, exist_ok=True)
            norm_path = out_dir / "prompt_normalized.wav"
            ta.save(str(norm_path), wav_in, sr_in, format="wav")
            normalized_prompt_path = str(norm_path)
            prompt_wav, prompt_sr = wav_in, sr_in
        except Exception:
            # If torchaudio cannot decode, fall back to raw path
            normalized_prompt_path = str(speaker_wav_path)

    # Introspect generate() signature to pass only supported kwargs
    sig = inspect.signature(model.generate)
    param_names = set(sig.parameters.keys())

    def filter_kwargs(base: dict) -> dict:
        return {k: v for k, v in base.items() if k in param_names and v is not None}

    base_kwargs = {"text": args.text}
    # Optional controls
    if "exaggeration" in param_names:
        base_kwargs["exaggeration"] = args.exaggeration
    if "cfg_weight" in param_names:
        base_kwargs["cfg_weight"] = args.cfg_weight
    if args.multilingual and args.language and "language" in param_names:
        base_kwargs["language"] = args.language

    base_kwargs = filter_kwargs(base_kwargs)

    # Try multiple possible prompt argument names/values
    tried: list[tuple[str, str]] = []
    wav = None
    used_prompt_arg = None
    last_err: Exception | None = None

    # Candidates to try with string path
    path_candidates = [
        "speaker_wav",
        "audio_prompt_path",
        "prompt_path",
        "voice_prompt_path",
        "reference_audio_path",
        "speaker_wav_path",
        "audio_prompt",
        "voice_prompt",
        "reference_audio",
        "prompt",
        "speaker_audio",
    ]
    # Candidates to try with waveform tensor
    tensor_candidates = [
        "speaker_wav",
        "audio_prompt",
        "voice_prompt",
        "reference_audio",
        "prompt",
        "speaker_audio",
    ]

    # Helper to attempt a call
    def try_call(prompt_key: str, value) -> tuple[bool, object | None, Exception | None]:
        nonlocal used_prompt_arg
        kwargs = dict(base_kwargs)
        if prompt_key in param_names:
            kwargs[prompt_key] = value
        try:
            out = model.generate(**kwargs)
            used_prompt_arg = prompt_key
            return True, out, None
        except TypeError as te:
            return False, None, te
        except Exception as e:
            return False, None, e

    # 1) Try with path
    if normalized_prompt_path is not None:
        for key in path_candidates:
            if key not in param_names:
                continue
            ok, out, err = try_call(key, normalized_prompt_path)
            tried.append((key, "path"))
            if ok:
                wav = out
                break
            last_err = err

    # 2) Try with tensor if path attempts failed
    if wav is None and prompt_wav is not None:
        for key in tensor_candidates:
            if key not in param_names:
                continue
            ok, out, err = try_call(key, prompt_wav)
            tried.append((key, "tensor"))
            if ok:
                wav = out
                break
            last_err = err

    # 3) If no prompt provided or all prompt attempts failed, try without prompt
    if wav is None:
        try:
            wav = model.generate(**base_kwargs)
            used_prompt_arg = None
        except Exception as e:
            last_err = e

    if wav is None:
        # Report the error and what we tried
        print(json.dumps({
            "error": f"Chatterbox generate() failed: {last_err}",
            "tried": tried,
            "accepted_params": sorted(param_names),
        }), file=sys.stdout, flush=True)
        return 4
    sr = getattr(model, "sr", 22050)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    ta.save(str(args.out), wav, sr, format="wav")

    # Duration in seconds from samples length
    try:
        duration_sec = float(wav.shape[-1]) / float(sr)
    except Exception:
        duration_sec = None

    print(json.dumps({
        "out_path": str(args.out),
        "duration_sec": duration_sec,
        "sr": sr,
        "used_prompt_arg": used_prompt_arg,
        "normalized_prompt_path": normalized_prompt_path,
    }), flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit as se:
        raise
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stdout, flush=True)
        sys.exit(1)
