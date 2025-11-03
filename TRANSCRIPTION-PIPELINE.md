# Speech Transcription Preparation Pipeline

These steps describe how to extract, clean, and transcribe dialogue from uploaded admin videos while keeping the entire workflow local. Follow this process before attempting voice cloning or alignment.

> **Prefer automation?** Use `scripts/transcribe_admin_video.py` to run every step below in one command.
> Example:
>
> ```bash
> python scripts/transcribe_admin_video.py \
>   --input-video ./uploads/example.mp4 \
>   --output-dir ./uploads/example_assets \
>   --model medium \
>   --device cpu
> ```
>
> The script writes `original_audio.wav`, `clean_audio.wav`, and `clean_audio.srt` to the output directory, mirroring the manual workflow.

## 1. Extract the Original Audio Track

Use `ffmpeg` to copy the highest-quality audio stream out of the source video without re-encoding.

```bash
ffmpeg -i input_video.mp4 -q:a 0 -map a original_audio.wav
```

- `-q:a 0` keeps the audio lossless.
- `-map a` ensures only the audio stream is written to the WAV file.
- Output: `original_audio.wav`, ready for noise reduction.

## 2. Clean and Preprocess the Audio

Perform noise removal, level matching, and optional silence trimming before transcription.

### Denoise and De-Reverb
- Use desktop tools (e.g., Audacity, Adobe Audition) or a Python workflow such as [`noisereduce`](https://github.com/timsainb/noisereduce).
- Focus on removing background hum, room tone, and harsh consonant noise.

### Normalize Loudness
- Target roughly **-3 dBFS peak** to prevent clipping in downstream tools.
- Example with `pydub`:

  ```python
  from pydub import AudioSegment, effects

  audio = AudioSegment.from_wav("original_audio.wav")
  normalized = effects.normalize(audio)  # peaks close to -3 dBFS
  normalized.export("clean_audio.wav", format="wav")
  ```

### Optional Silence Trimming
- Use `ffmpeg`'s `silenceremove` or `pydub`'s `strip_silence` to shorten long pauses.
- Keep enough context before/after each sentence for accurate alignment later.

Output: `clean_audio.wav` — the denoised, normalized reference track.

## 3. Produce a Local Transcript with Timestamps

Run a locally hosted speech-to-text model so transcripts stay inside your infrastructure. Whisper is recommended for accuracy versus compute cost.

```bash
whisper clean_audio.wav --model medium --output_format srt --device cpu
```

- `--model medium` balances speed and quality; choose `large` for best accuracy when GPUs are available.
- `--output_format srt` generates subtitle segments with start/end timestamps.
- `--device cpu` keeps the run on local hardware; omit if you have a GPU build.

Output: `clean_audio.srt`, mapping each dialogue segment to precise times.

### Resulting Artifacts
1. `original_audio.wav` – direct extraction from the video.
2. `clean_audio.wav` – denoised and normalized speech for analysis or cloning.
3. `clean_audio.srt` – timestamped transcript used to sync cloned speech.

Keep these files paired with the source video for future alignment, overdubbing, or QA steps.
