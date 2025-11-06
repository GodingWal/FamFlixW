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
import os
import shutil
from typing import Any

try:
    import numpy as np  # type: ignore
except Exception:
    np = None  # numpy is optional at import-time; we can still proceed if not present


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Chatterbox TTS CLI")
    parser.add_argument("--text", required=True, help="Text to synthesize")
    parser.add_argument("--out", required=True, type=Path, help="Output WAV path")
    parser.add_argument("--speaker-wav", dest="speaker_wav", type=Path, help="Reference voice WAV path for cloning")
    parser.add_argument("--device", default="cpu", help="torch device: cpu or cuda")
    parser.add_argument("--language", default="en", help="Language id for multilingual model (e.g. en, fr, zh)")
    parser.add_argument("--multilingual", action="store_true", help="Use multilingual model")
    parser.add_argument("--exaggeration", type=float, default=0.5, help="Emotion/exaggeration control (0..1)")
    parser.add_argument("--cfg-weight", dest="cfg_weight", type=float, default=0.5, help="Guidance weight (0..1)")
    parser.add_argument(
        "--steps",
        type=int,
        default=int(os.environ.get("CHATTERBOX_STEPS", "50")),
        help="Number of inference steps for model.generate() if supported (CPU-friendly default)",
    )
    parser.add_argument(
        "--attn-impl",
        dest="attn_impl",
        default=os.environ.get("CHATTERBOX_ATTN_IMPL"),
        help="Attention implementation hint for model.generate() or model (e.g., 'eager') if supported",
    )
    parser.add_argument(
        "--max-new-tokens",
        dest="max_new_tokens",
        type=int,
        default=int(os.environ.get("CHATTERBOX_MAX_NEW_TOKENS", "64")),
        help="Limit LLM token generation if model.generate() accepts it (e.g., max_new_tokens)",
    )

    args = parser.parse_args(argv)

    try:
        import torch
        import torchaudio as ta
        import torchaudio.functional as TAF
        from chatterbox.tts import ChatterboxTTS
        if args.multilingual:
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # type: ignore
    except Exception as exc:
        print(json.dumps({
            "error": f"Missing dependencies: {exc}. Install with: pip install chatterbox-tts torch torchaudio"
        }), file=sys.stdout, flush=True)
        return 2

    device = args.device
    try:
        if device.startswith("cuda") and not torch.cuda.is_available():
            device = "cpu"
    except Exception:
        device = "cpu"

    # CPU thread tuning for better predictability on CPU
    try:
        import os as _os
        _nt = int(_os.environ.get("TORCH_NUM_THREADS", "2"))
        _it = int(_os.environ.get("TORCH_NUM_INTEROP_THREADS", "1"))
        torch.set_num_threads(_nt)
        torch.set_num_interop_threads(_it)
    except Exception:
        pass

    # Load model, passing attention implementation to from_pretrained if supported
    pretrained_kwargs = {}
    if args.attn_impl:
        try:
            if "attn_implementation" in inspect.signature(ChatterboxTTS.from_pretrained).parameters:
                pretrained_kwargs["attn_implementation"] = args.attn_impl
        except Exception:
            pass

    try:
        if args.multilingual:
            model = ChatterboxMultilingualTTS.from_pretrained(device=device, **pretrained_kwargs)  # type: ignore[name-defined]
        else:
            model = ChatterboxTTS.from_pretrained(device=device, **pretrained_kwargs)
    except TypeError:
        # Fallback if the extra kwargs are not supported
        if args.multilingual:
            model = ChatterboxMultilingualTTS.from_pretrained(device=device)  # type: ignore[name-defined]
        else:
            model = ChatterboxTTS.from_pretrained(device=device)

    # Try to set attention implementation flag on model/pipeline if present
    if args.attn_impl:
        for obj in [model, getattr(model, "pipeline", None), getattr(model, "model", None)]:
            if obj is not None and hasattr(obj, "attn_implementation"):
                try:
                    setattr(obj, "attn_implementation", args.attn_impl)
                except Exception:
                    pass

    # Clamp token generation on HF text backends if accessible
    for obj in [model, getattr(model, "pipeline", None), getattr(model, "model", None), getattr(model, "generator", None)]:
        if obj is None:
            continue
        gen_cfg = getattr(obj, "generation_config", None)
        if gen_cfg is not None:
            try:
                if hasattr(gen_cfg, "max_new_tokens"):
                    setattr(gen_cfg, "max_new_tokens", int(max(1, args.max_new_tokens)))
                if hasattr(gen_cfg, "max_length"):
                    # Ensure total length is reasonable on CPU
                    ml = int(max(8, args.max_new_tokens + 16))
                    setattr(gen_cfg, "max_length", ml)
            except Exception:
                pass

    # Try to set default step count on model/pipeline if exposed as attribute
    for obj in [model, getattr(model, "pipeline", None), getattr(model, "diffusion", None)]:
        if obj is None:
            continue
        for key in [
            "num_inference_steps","steps","n_steps","inference_steps","num_steps",
            "num_sampling_steps","n_inference_steps","num_iters","n_iters","iterations",
        ]:
            if hasattr(obj, key):
                try:
                    setattr(obj, key, args.steps)
                    break
                except Exception:
                    pass

    # Debug: print effective settings (stderr so stdout remains JSON-only for the pipeline)
    try:
        print(f"[chatterbox] device={device} steps={args.steps} attn_impl={args.attn_impl}", file=sys.stderr, flush=True)
    except Exception:
        pass

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
    has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())

    def filter_kwargs(base: dict) -> dict:
        if has_var_kw:
            return {k: v for k, v in base.items() if v is not None}
        return {k: v for k, v in base.items() if (k in param_names) and (v is not None)}

    base_kwargs = {"text": args.text}
    # Optional controls
    if "exaggeration" in param_names:
        base_kwargs["exaggeration"] = args.exaggeration
    if "cfg_weight" in param_names:
        base_kwargs["cfg_weight"] = args.cfg_weight
    if args.multilingual and args.language and "language" in param_names:
        base_kwargs["language"] = args.language

    # Steps mapping to common parameter names
    step_param_candidates = [
        "num_inference_steps",
        "steps",
        "n_steps",
        "inference_steps",
        "num_steps",
        "num_sampling_steps",
        "n_inference_steps",
        "num_iters",
        "n_iters",
        "iterations",
    ]
    step_key_to_use = None
    for key in step_param_candidates:
        if key in param_names:
            step_key_to_use = key
            break
    # If generate() accepts **kwargs, pass a sensible default key even if it's not in the signature
    if step_key_to_use is None and has_var_kw:
        step_key_to_use = "num_inference_steps"
    if step_key_to_use is not None:
        base_kwargs[step_key_to_use] = args.steps
    # Optional attention implementation knob
    if args.attn_impl and "attn_implementation" in param_names:
        base_kwargs["attn_implementation"] = args.attn_impl

    # Token generation limit for internal LLMs
    token_param_candidates = [
        "max_new_tokens", "max_length", "new_tokens", "tokens",
    ]
    for key in token_param_candidates:
        if has_var_kw or (key in param_names):
            base_kwargs[key] = int(max(1, args.max_new_tokens))
            break

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
    # Normalize output and persist as WAV
    sr = int(getattr(model, "sr", 22050) or 22050)

    # Some implementations may return (audio, sr)
    if isinstance(wav, (tuple, list)) and len(wav) >= 2 and isinstance(wav[1], int):
        wav, sr = wav[0], int(wav[1])

    args.out.parent.mkdir(parents=True, exist_ok=True)

    def _to_tensor(x: Any):
        """Convert numpy array or torch tensor-like to torch.Tensor [channels, samples]."""
        try:
            import torch  # local import to avoid global dependency at parse time
        except Exception as e:  # pragma: no cover
            raise RuntimeError(f"torch not available to save audio: {e}")

        if x is None:
            raise RuntimeError("generate() returned None")

        # Already a torch tensor
        if hasattr(x, "dim") and hasattr(x, "dtype"):
            t = x
        elif np is not None and isinstance(x, np.ndarray):
            import torch as _torch  # noqa
            t = _torch.from_numpy(x)
        else:
            # Unknown type
            raise RuntimeError(f"Unsupported audio return type: {type(x)}")

        # Ensure [channels, samples]
        if getattr(t, "dim", lambda: 0)() == 1:
            t = t.unsqueeze(0)
        elif t.dim() > 2:
            # Flatten extra dims conservatively: take first channel-like dimension
            t = t.reshape(t.shape[0], -1) if t.dim() >= 2 else t

        # Cast to float32 if needed
        try:
            import torch as _torch
            if t.dtype not in (
                getattr(_torch, "float32", None),
                getattr(_torch, "float", None),
            ):
                t = t.float()
        except Exception:
            pass
        return t

    saved_path = args.out
    duration_sec = None

    try:
        # Case 1: model returned a path
        if isinstance(wav, (str, os.PathLike, Path)):
            src = Path(wav)
            if not src.exists():
                raise RuntimeError(f"Returned audio path does not exist: {src}")
            # Try to re-encode to WAV to guarantee format
            try:
                audio, sr_in = ta.load(str(src))
                if int(sr_in) != sr:
                    audio = TAF.resample(audio, int(sr_in), sr)
                ta.save(str(args.out), audio, sr, format="wav")
            except Exception:
                # Fallback: copy as-is; downstream ffmpeg/pydub can often read common formats
                shutil.copy2(src, args.out)
        else:
            # Case 2: tensor/ndarray-like
            tensor = _to_tensor(wav)
            ta.save(str(args.out), tensor, sr, format="wav")

        # Compute duration from saved file metadata if possible
        try:
            info = ta.info(str(args.out))
            if getattr(info, "num_frames", 0) and getattr(info, "sample_rate", 0):
                duration_sec = float(info.num_frames) / float(info.sample_rate)
        except Exception:
            duration_sec = None
    except Exception as e:
        print(json.dumps({
            "error": f"Failed to persist audio: {e}",
        }), file=sys.stdout, flush=True)
        return 5

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
