import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { promises as fsp } from "fs";
import { PassThrough, Transform } from "stream";
import { pipeline } from "stream/promises";
import { createHash } from "crypto";
import { nanoid } from "nanoid";

import { config } from "../../config";
import { uploadStreamToS3 } from "../../utils/s3";
import type { ITTSProvider, TTSInput, TTSResult } from "../TTSProvider";

export class ChatterboxProvider implements ITTSProvider {
  private readonly scriptPath: string;
  private readonly pythonBin: string;

  constructor() {
    this.scriptPath = path.resolve(process.cwd(), config.CHATTERBOX_SCRIPT_PATH || "scripts/chatterbox_tts.py");
    this.pythonBin = config.PYTHON_BIN || "python3";
  }

  async synthesize({ text, voiceRef, storyId, sectionId }: TTSInput): Promise<TTSResult> {
    if (!voiceRef) {
      throw new Error("Voice reference (audio prompt path) is required for Chatterbox TTS");
    }

    const absPrompt = path.isAbsolute(voiceRef)
      ? voiceRef
      : path.resolve(process.cwd(), voiceRef.replace(/^\//, ""));

    const tempDir = path.resolve(process.cwd(), "temp");
    await fsp.mkdir(tempDir, { recursive: true });

    const outFile = path.join(
      tempDir,
      `cb-${Date.now()}-${nanoid(6)}.wav`
    );

    const args: string[] = [
      this.scriptPath,
      "--text",
      text,
      "--out",
      outFile,
      "--audio-prompt",
      absPrompt,
    ];

    if (config.CHATTERBOX_DEVICE) {
      args.push("--device", String(config.CHATTERBOX_DEVICE));
    }
    if (config.CHATTERBOX_MULTILINGUAL) {
      args.push("--multilingual");
    }
    if (config.CHATTERBOX_LANGUAGE_ID) {
      args.push("--language", String(config.CHATTERBOX_LANGUAGE_ID));
    }
    if (typeof config.CHATTERBOX_EXAGGERATION === "number") {
      args.push("--exaggeration", String(config.CHATTERBOX_EXAGGERATION));
    }
    if (typeof config.CHATTERBOX_CFG_WEIGHT === "number") {
      args.push("--cfg-weight", String(config.CHATTERBOX_CFG_WEIGHT));
    }

    const stdout = await this.runPython(args);

    let payload: any = null;
    try {
      payload = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() || "{}");
      if (payload && payload.error) {
        throw new Error(String(payload.error));
      }
    } catch (err) {
      throw new Error(`Chatterbox CLI returned invalid output: ${String(err)}`);
    }

    // Upload to S3
    const keyBase = config.STORY_AUDIO_PREFIX.replace(/\/$/, "");
    const s3Key = `${keyBase}/raw/${Date.now()}-cb-${nanoid(6)}.wav`;

    const checksum = createHash("md5");
    const pass = new PassThrough();

    const uploadPromise = uploadStreamToS3(s3Key, "audio/wav", pass);

    await pipeline(
      fs.createReadStream(outFile),
      new Transform({
        transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: unknown) => void) {
          checksum.update(chunk);
          cb(null, chunk);
        },
      }),
      pass
    );

    const { url } = await uploadPromise;

    // Optionally clean up temp file
    try { await fsp.unlink(outFile); } catch (e) {
      // ignore cleanup errors
    }

    return {
      key: s3Key,
      url,
      checksum: checksum.digest("hex"),
      durationSec: typeof payload?.duration_sec === "number" ? payload.duration_sec : undefined,
      transcript: undefined,
    } satisfies TTSResult;
  }

  private runPython(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonBin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      proc.on("error", (e: Error) => reject(e));
      proc.on("close", (code: number | null) => {
        if (code === 0) return resolve(out);
        reject(new Error(`Chatterbox process exited with code ${code}: ${err || out}`));
      });
    });
  }
}
