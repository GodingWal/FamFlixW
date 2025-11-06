import { storage } from "../storage";
import { InsertVoiceProfile, InsertVoiceGeneration } from "../db/schema";
import { promises as fs } from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { spawn } from "child_process";
import { config } from "../config";

export class VoiceService {
  private readonly audioStoragePath = path.resolve(process.cwd(), "uploads", "audio");
  private readonly tempDir = path.resolve(process.cwd(), "temp");
  private readonly chatterboxScript = path.resolve(process.cwd(), config.CHATTERBOX_SCRIPT_PATH || "scripts/chatterbox_tts.py");
  private readonly pythonBin = config.PYTHON_BIN || "python3";

  constructor() {
    // Ensure audio storage directory exists
    this.ensureStorageDirectory();
  }

  // Decode arbitrary audio (MP3/OGG/M4A/WAV/etc.) into PCM WAV using ffmpeg via stdin/stdout
  private async decodeAudioToWav(input: Buffer, targetSampleRate = 24000, targetChannels = 1, targetBitDepth = 16): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn', '-sn', '-dn',
        '-ac', String(Math.max(1, targetChannels)),
        '-ar', String(targetSampleRate),
        '-f', 'wav',
        ...(targetBitDepth === 24 ? ['-acodec', 'pcm_s24le'] : ['-acodec', 'pcm_s16le']),
        'pipe:1',
      ];
      const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let err = '';
      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('error', (e: Error) => reject(e));
      proc.on('close', (code: number | null) => {
        if (code === 0) return resolve(Buffer.concat(chunks));
        reject(new Error(`ffmpeg decode failed with code ${code}: ${err}`));
      });
      proc.stdin.write(input);
      proc.stdin.end();
    });
  }

  // Minimal prompt preprocessing for Chatterbox: keep identity, standardize container/format
  private async preprocessChatterboxPrompt(audioBuffer: Buffer): Promise<Buffer> {
    try {
      let workingBuffer = audioBuffer;
      // Properly decode non-WAV uploads (e.g., MP3/OGG/M4A) using ffmpeg; do NOT wrap raw bytes
      if (!this.isWavBuffer(workingBuffer)) {
        workingBuffer = await this.decodeAudioToWav(workingBuffer, 24000, 1, 16);
      }

      let audioInfo = await this.analyzeAudioBuffer(workingBuffer);

      // Chatterbox commonly operates at 24kHz mono; keep 16-bit PCM
      const TARGET_SR = 24000;
      const TARGET_CH = 1;
      const TARGET_BIT = 16;

      if (
        audioInfo.sampleRate !== TARGET_SR ||
        audioInfo.channels !== TARGET_CH ||
        audioInfo.bitDepth !== TARGET_BIT
      ) {
        workingBuffer = await this.convertToTargetFormat(workingBuffer, audioInfo, TARGET_SR, TARGET_CH, TARGET_BIT);
        audioInfo = await this.analyzeAudioBuffer(workingBuffer);
      }

      // Light normalization only (no denoise / HPF to preserve timbre)
      try {
        const dataStart = (audioInfo as any).dataOffset ?? 44;
        const dataEnd = dataStart + ((audioInfo as any).dataSize ?? Math.max(0, workingBuffer.length - dataStart));
        const safeEnd = Math.min(workingBuffer.length, dataEnd);
        const audioData = workingBuffer.slice(dataStart, safeEnd);
        const samples = this.extractSamples(audioData, audioInfo);
        const normalized = this.normalizeAudio(samples);
        return this.createWavBuffer(normalized, audioInfo.sampleRate, audioInfo.channels, audioInfo.bitDepth);
      } catch {
        return workingBuffer;
      }
    } catch (error) {
      console.error('Chatterbox prompt preprocessing error:', error);
      return audioBuffer;
    }
  }

  private async ensureStorageDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.audioStoragePath, { recursive: true });
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      console.error("Failed to create audio storage directory:", error);
    }
  }

  async createVoiceClone(audioFile: Buffer, name: string, userId: string, familyId?: string): Promise<string> {
    return this.createVoiceCloneFromFiles([audioFile], name, userId, familyId);
  }

  async createVoiceCloneFromFiles(audioFiles: Buffer[], name: string, userId: string, familyId?: string, recordingMetadata?: any[]): Promise<string> {
    try {
      console.log(`Creating zero-shot voice clone (Chatterbox) for ${name} with ${audioFiles.length} audio files...`);

      const metaList = Array.isArray(recordingMetadata) ? recordingMetadata : [];

      // Determine durations, falling back to analyzing a safe, temporary WAV view when needed
      const augmentedFiles: Array<{ buffer: Buffer; metadata?: any; duration: number }> = [];
      for (let i = 0; i < audioFiles.length; i++) {
        const originalBuffer = audioFiles[i];
        const metadata = metaList[i];
        let duration: number | undefined = typeof metadata?.duration === 'number' ? metadata.duration : undefined;

        try {
          // Use a separate buffer for analysis so we never mutate the original recording bytes
          let analysisBuffer = originalBuffer;
          if (!this.isWavBuffer(analysisBuffer)) {
            analysisBuffer = await this.decodeAudioToWav(analysisBuffer).catch(() => Buffer.alloc(0));
          }
          if (duration === undefined) {
            const info = await this.analyzeAudioBuffer(analysisBuffer);
            duration = info.duration;
            console.log(`[voice] analyzed input #${i}: ${info.format} ${info.channels}ch @ ${info.sampleRate}Hz, ${info.bitDepth}bit, duration=${duration?.toFixed?.(2) ?? duration}s`);
          }
        } catch {
          // If analysis fails, duration remains undefined
        }

        // Fallback rough estimate if analysis failed: assume 24kHz mono float32 (~96kB/sec)
        if (!Number.isFinite(duration as number)) {
          const est = Math.max(0, Math.round((originalBuffer.length / 96000) * 100) / 100);
          duration = est;
          console.warn(`[voice] duration analysis failed for input #${i}; using size-based estimate ~${est}s from ${originalBuffer.length} bytes`);
        }

        // Always push the ORIGINAL buffer so downstream preprocessing can properly decode (e.g., webm/mp3 -> WAV)
        augmentedFiles.push({ buffer: originalBuffer, metadata, duration: Number(duration) });
      }

      const validAudioFiles = augmentedFiles.filter(({ duration }) => duration >= 3);

      if (validAudioFiles.length === 0) {
        throw new Error("No valid audio recordings were provided. Please include at least one clip longer than 3 seconds.");
      }

      // Preprocess to consistent WAV for Chatterbox (minimal processing to preserve voice identity)
      const processedRecordings: Array<{ buffer: Buffer; duration: number; metadata?: any }> = [];
      for (const recording of validAudioFiles) {
        const processedAudio = await this.preprocessChatterboxPrompt(recording.buffer);
        processedRecordings.push({ buffer: processedAudio, duration: recording.duration, metadata: recording.metadata });
      }

      const totalDuration = processedRecordings.reduce((sum, rec) => sum + rec.duration, 0);

      // Create a single audio prompt file (combined if multiple)
      const promptBuffer = processedRecordings.length > 1
        ? await this.combineProcessedAudioFiles(processedRecordings.map(r => r.buffer))
        : processedRecordings[0].buffer;

      const audioFileName = `${nanoid()}_${Date.now()}_prompt.wav`;
      const audioFilePath = path.join(this.audioStoragePath, audioFileName);
      await fs.writeFile(audioFilePath, promptBuffer);

      // Create voice profile pointing to the prompt file
      const voiceProfile = await storage.createVoiceProfile({
        name,
        userId,
        familyId,
        provider: "CHATTERBOX" as any,
        providerRef: audioFilePath, // Local path used by Chatterbox CLI as audio_prompt
        audioSampleUrl: `/uploads/audio/${audioFileName}`,
        trainingProgress: 100,
        status: "ready",
        metadata: {
          isRealClone: true,
          cloneType: "zero_shot",
          totalInputDuration: totalDuration,
          createdAt: new Date().toISOString(),
          chatterbox: {
            audioPromptPath: audioFilePath,
            multilingual: config.CHATTERBOX_MULTILINGUAL,
            device: config.CHATTERBOX_DEVICE,
          },
          originalDurations: processedRecordings.map(rec => rec.duration),
          originalFileSizes: validAudioFiles.map(rec => rec.buffer.length),
        },
      } as InsertVoiceProfile);

      console.log(`Voice profile created (Chatterbox) with providerRef=${audioFilePath}`);
      return voiceProfile.id;
    } catch (error: any) {
      console.error("Voice cloning error (Chatterbox):", error);
      throw new Error(`Voice cloning failed: ${error.message || 'Unknown error occurred'}. Please try again.`);
    }
  }

  

  private isWavBuffer(buffer: Buffer): boolean {
    return (
      buffer.length > 44 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WAVE'
    );
  }

  private wrapRawAudioAsWav(audioBuffer: Buffer): Buffer {
    const sampleRate = 44100;
    const channels = 1;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = audioBuffer.length;
    const fileSize = 44 + dataSize;

    const wavBuffer = Buffer.alloc(fileSize);

    wavBuffer.write('RIFF', 0);
    wavBuffer.writeUInt32LE(fileSize - 8, 4);
    wavBuffer.write('WAVE', 8);
    wavBuffer.write('fmt ', 12);
    wavBuffer.writeUInt32LE(16, 16);
    wavBuffer.writeUInt16LE(1, 20);
    wavBuffer.writeUInt16LE(channels, 22);
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(byteRate, 28);
    wavBuffer.writeUInt16LE(blockAlign, 32);
    wavBuffer.writeUInt16LE(bitDepth, 34);
    wavBuffer.write('data', 36);
    wavBuffer.writeUInt32LE(dataSize, 40);

    audioBuffer.copy(wavBuffer, 44);

    return wavBuffer;
  }

  private async analyzeAudioBuffer(buffer: Buffer): Promise<{
    sampleRate: number;
    channels: number;
    bitDepth: number;
    format: string;
    duration: number;
    dataOffset: number;
    dataSize: number;
  }> {
    // Robust RIFF/WAV parser: scan chunks to locate 'fmt ' and 'data'
    if (buffer.length < 44) {
      throw new Error('Audio buffer too small to contain valid WAV header');
    }

    const riff = buffer.toString('ascii', 0, 4);
    const wave = buffer.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      throw new Error('Not a valid WAV file (missing RIFF/WAVE)');
    }

    let audioFormatCode: number | undefined;
    let channels: number | undefined;
    let sampleRate: number | undefined;
    let bitsPerSample: number | undefined;
    let dataSize: number | undefined;
    let dataOffset: number | undefined;

    let offset = 12; // start of first chunk
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      const next = chunkStart + chunkSize + (chunkSize % 2); // chunks are word-aligned

      if (chunkId === 'fmt ') {
        if (chunkStart + 16 <= buffer.length) {
          audioFormatCode = buffer.readUInt16LE(chunkStart + 0);
          channels = buffer.readUInt16LE(chunkStart + 2);
          sampleRate = buffer.readUInt32LE(chunkStart + 4);
          // skip byteRate (4), blockAlign (2)
          bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
        }
      } else if (chunkId === 'data') {
        dataSize = Math.min(chunkSize, Math.max(0, buffer.length - chunkStart));
        dataOffset = chunkStart;
        // Found data; we can stop scanning further
        offset = next;
        break;
      }

      offset = next;
    }

    if (
      audioFormatCode === undefined ||
      channels === undefined ||
      sampleRate === undefined ||
      bitsPerSample === undefined ||
      dataSize === undefined ||
      dataOffset === undefined
    ) {
      throw new Error('Incomplete WAV header (missing fmt/data chunks)');
    }

    const bytesPerSample = (bitsPerSample / 8) * channels;
    const totalSamples = bytesPerSample > 0 ? dataSize / bytesPerSample : 0;
    const duration = totalSamples / sampleRate;

    const fmtLabel = audioFormatCode === 1 ? 'PCM' : audioFormatCode === 3 ? 'FLOAT' : `FORMAT_${audioFormatCode}`;
    return {
      sampleRate,
      channels,
      bitDepth: bitsPerSample,
      format: fmtLabel,
      duration,
      dataOffset,
      dataSize,
    };
  }

  private async convertToTargetFormat(
    buffer: Buffer,
    audioInfo: {
      sampleRate: number;
      channels: number;
      bitDepth: number;
      format?: string;
      dataOffset?: number;
      dataSize?: number;
    },
    targetSampleRate: number,
    targetChannels: number,
    targetBitDepth: number,
  ): Promise<Buffer> {
    const normalizedChannels = Math.max(1, Number.isFinite(targetChannels) ? Math.floor(targetChannels) : 1);
    const normalizedBitDepth = targetBitDepth === 24 ? 24 : 16;

    if (
      audioInfo.sampleRate === targetSampleRate &&
      audioInfo.channels === normalizedChannels &&
      audioInfo.bitDepth === normalizedBitDepth
    ) {
      return buffer;
    }

    console.log(
      `Converting audio: ${audioInfo.sampleRate}Hz → ${targetSampleRate}Hz, ${audioInfo.channels}ch → ${normalizedChannels}ch, ${audioInfo.bitDepth}bit → ${normalizedBitDepth}bit`,
    );

    const dataStart = (audioInfo as any).dataOffset ?? 44;
    const dataEnd = dataStart + ((audioInfo as any).dataSize ?? Math.max(0, buffer.length - dataStart));
    const safeEnd = Math.min(buffer.length, dataEnd);
    const audioData = buffer.slice(dataStart, safeEnd);
    let processedSamples = this.extractSamples(audioData, audioInfo);

    if (audioInfo.channels !== normalizedChannels) {
      if (normalizedChannels === 1) {
        processedSamples = this.convertToMono(processedSamples, audioInfo.channels);
      } else {
        const baseSamples = audioInfo.channels === 1 ? processedSamples : this.convertToMono(processedSamples, audioInfo.channels);
        processedSamples = this.duplicateChannels(baseSamples, normalizedChannels);
      }
    }

    if (audioInfo.sampleRate !== targetSampleRate) {
      processedSamples = this.resampleAudio(processedSamples, audioInfo.sampleRate, targetSampleRate);
    }

    return this.createWavBuffer(processedSamples, targetSampleRate, normalizedChannels, normalizedBitDepth);
  }

  private async convertToOptimalFormat(buffer: Buffer, audioInfo: any): Promise<Buffer> {
    return this.convertToTargetFormat(buffer, audioInfo, 44100, 1, 16);
  }

  private duplicateChannels(samples: number[], channels: number): number[] {
    if (channels <= 1) return samples;

    const duplicated = new Array<number>(samples.length * channels);
    let offset = 0;
    for (const sample of samples) {
      for (let c = 0; c < channels; c++) {
        duplicated[offset++] = sample;
      }
    }

    return duplicated;
  }

  private extractSamples(audioData: Buffer, audioInfo: any): number[] {
    const samples: number[] = [];
    const bytesPerSample = audioInfo.bitDepth / 8;
    
    const frameSize = bytesPerSample * audioInfo.channels;
    if (!Number.isFinite(frameSize) || frameSize <= 0) return samples;

    for (let i = 0; i + frameSize <= audioData.length; i += frameSize) {
      for (let channel = 0; channel < audioInfo.channels; channel++) {
        const sampleOffset = i + (channel * bytesPerSample);
        if (sampleOffset < 0 || sampleOffset + bytesPerSample > audioData.length) {
          // Avoid out-of-bounds reads on final partial frame
          continue;
        }
        let sample = 0;

        const isFloat = String(audioInfo.format || '').toUpperCase().includes('FLOAT');
        if (isFloat && audioInfo.bitDepth === 32) {
          // IEEE float 32
          sample = audioData.readFloatLE(sampleOffset);
        } else if (audioInfo.bitDepth === 16) {
          sample = audioData.readInt16LE(sampleOffset) / 32768.0;
        } else if (audioInfo.bitDepth === 24) {
          // Read 24-bit sample (3 bytes)
          const byte1 = audioData.readUInt8(sampleOffset);
          const byte2 = audioData.readUInt8(sampleOffset + 1);
          const byte3 = audioData.readUInt8(sampleOffset + 2);
          sample = ((byte3 << 16) | (byte2 << 8) | byte1);
          if (sample & 0x800000) sample |= 0xFF000000; // Sign extend
          sample = sample / 8388608.0;
        } else if (audioInfo.bitDepth === 32) {
          // 32-bit signed PCM
          sample = audioData.readInt32LE(sampleOffset) / 2147483648.0;
        }

        samples.push(Math.max(-1, Math.min(1, sample))); // Clamp to [-1, 1]
      }
    }

    return samples;
  }

  private convertToMono(samples: number[], channels: number): number[] {
    if (channels === 1) return samples;

    const monoSamples: number[] = [];
    for (let i = 0; i < samples.length; i += channels) {
      // Average all channels to create mono
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += samples[i + c] || 0;
      }
      monoSamples.push(sum / channels);
    }

    return monoSamples;
  }

  private resampleAudio(samples: number[], inputRate: number, outputRate: number): number[] {
    if (inputRate === outputRate) return samples;

    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(samples.length / ratio);
    const resampled: number[] = [];

    for (let i = 0; i < outputLength; i++) {
      const sourceIndex = i * ratio;
      const index = Math.floor(sourceIndex);
      const fraction = sourceIndex - index;

      if (index + 1 < samples.length) {
        // Linear interpolation
        const sample1 = samples[index];
        const sample2 = samples[index + 1];
        resampled.push(sample1 + (sample2 - sample1) * fraction);
      } else {
        resampled.push(samples[index] || 0);
      }
    }

    return resampled;
  }

  private createWavBuffer(samples: number[], sampleRate: number, channels: number, bitDepth: number): Buffer {
    const bytesPerSample = bitDepth / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples.length * bytesPerSample;
    const fileSize = 44 + dataSize;

    const buffer = Buffer.alloc(fileSize);

    // WAV Header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(fileSize - 8, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size
    buffer.writeUInt16LE(1, 20);  // AudioFormat (PCM)
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Audio Data
    let offset = 44;
    for (const sample of samples) {
      const clampedSample = Math.max(-1, Math.min(1, sample));
      
      if (bitDepth === 16) {
        buffer.writeInt16LE(Math.round(clampedSample * 32767), offset);
        offset += 2;
      } else if (bitDepth === 24) {
        const intSample = Math.round(clampedSample * 8388607);
        buffer.writeUInt8(intSample & 0xFF, offset);
        buffer.writeUInt8((intSample >> 8) & 0xFF, offset + 1);
        buffer.writeUInt8((intSample >> 16) & 0xFF, offset + 2);
        offset += 3;
      }
    }

    return buffer;
  }

  private async enhanceAudioQuality(audioBuffer: Buffer, audioInfoOverride?: {
    sampleRate: number;
    channels: number;
    bitDepth: number;
  }): Promise<Buffer> {
    // Apply basic audio enhancements for better voice cloning
    try {
      const audioInfo = audioInfoOverride || await this.analyzeAudioBuffer(audioBuffer);
      const dataStart = (audioInfo as any).dataOffset ?? 44;
      const dataEnd = dataStart + ((audioInfo as any).dataSize ?? Math.max(0, audioBuffer.length - 44));
      const safeEnd = Math.min(audioBuffer.length, dataEnd);
      const audioData = audioBuffer.slice(dataStart, safeEnd);
      const samples = this.extractSamples(audioData, audioInfo);

      // Remove low-level ambient noise before normalization
      const denoisedSamples = this.reduceBackgroundNoise(samples, audioInfo.sampleRate);

      // Apply gentle normalization
      const normalizedSamples = this.normalizeAudio(denoisedSamples);

      // Apply subtle high-pass filter to remove low-frequency noise
      const filteredSamples = this.highPassFilter(normalizedSamples, audioInfo.sampleRate);

      return this.createWavBuffer(filteredSamples, audioInfo.sampleRate, audioInfo.channels, audioInfo.bitDepth);
    } catch (error) {
      console.error('Audio enhancement error:', error);
      return audioBuffer; // Return original if enhancement fails
    }
  }

  private normalizeAudio(samples: number[]): number[] {
    // Find peak amplitude iteratively to avoid spreading very large arrays
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }

    if (!Number.isFinite(peak) || peak <= 0) return samples;

    // Normalize to -3dB to prevent clipping (0.707 ≈ -3dB)
    const targetPeak = 0.707;
    const gain = targetPeak / peak;

    const out = new Array<number>(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = samples[i] * gain;
    }
    return out;
  }

  private reduceBackgroundNoise(samples: number[], sampleRate: number): number[] {
    if (samples.length === 0) {
      return samples;
    }

    const windowSize = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms windows
    const energyWindows: number[] = [];

    for (let i = 0; i < samples.length; i += windowSize) {
      let sum = 0;
      let count = 0;
      for (let j = 0; j < windowSize && i + j < samples.length; j++) {
        const sample = samples[i + j];
        sum += sample * sample;
        count++;
      }

      if (count > 0) {
        energyWindows.push(Math.sqrt(sum / count));
      }
    }

    const sortedEnergy = energyWindows.slice().sort((a, b) => a - b);
    const noiseFloor = sortedEnergy.length > 0 ? sortedEnergy[Math.floor(sortedEnergy.length * 0.25)] : 0;
    const threshold = noiseFloor > 0 ? noiseFloor * 1.6 : 0.02;

    const cleaned = samples.slice();
    for (let i = 0; i < cleaned.length; i++) {
      const absSample = Math.abs(cleaned[i]);
      if (absSample < threshold) {
        const attenuation = Math.pow(absSample / threshold, 1.5);
        cleaned[i] = cleaned[i] * attenuation * 0.5;
      }
    }

    // Gentle smoothing to avoid gate artifacts
    for (let i = 1; i < cleaned.length - 1; i++) {
      cleaned[i] = (cleaned[i - 1] + cleaned[i] * 2 + cleaned[i + 1]) / 4;
    }

    return cleaned;
  }

  private highPassFilter(samples: number[], sampleRate: number): number[] {
    // Simple high-pass filter to remove rumble below 80Hz
    const cutoffFreq = 80; // Hz
    const dt = 1.0 / sampleRate;
    const rc = 1.0 / (2 * Math.PI * cutoffFreq);
    const alpha = rc / (rc + dt);

    const filtered: number[] = [];
    let prevInput = 0;
    let prevOutput = 0;

    for (const sample of samples) {
      const output = alpha * (prevOutput + sample - prevInput);
      filtered.push(output);
      prevInput = sample;
      prevOutput = output;
    }

    return filtered;
  }

  private async combineProcessedAudioFiles(audioBuffers: Buffer[]): Promise<Buffer> {
    if (audioBuffers.length === 0) {
      throw new Error('No audio buffers provided for combination');
    }

    console.log(`Combining ${audioBuffers.length} processed recordings into a single training file`);

    const sampleSegments: number[][] = [];
    let referenceInfo = await this.analyzeAudioBuffer(audioBuffers[0]);

    for (let index = 0; index < audioBuffers.length; index++) {
      let buffer = audioBuffers[index];
      let info = await this.analyzeAudioBuffer(buffer);

      // If the current buffer deviates from the reference format, normalize it
      if (
        info.sampleRate !== referenceInfo.sampleRate ||
        info.channels !== referenceInfo.channels ||
        info.bitDepth !== referenceInfo.bitDepth
      ) {
        buffer = await this.convertToTargetFormat(
          buffer,
          info,
          referenceInfo.sampleRate,
          referenceInfo.channels,
          referenceInfo.bitDepth,
        );
        info = await this.analyzeAudioBuffer(buffer);

        if (index === 0) {
          referenceInfo = info;
        }
      }

      const dataStart = (info as any).dataOffset ?? 44;
      const dataEnd = dataStart + ((info as any).dataSize ?? Math.max(0, buffer.length - 44));
      const safeEnd = Math.min(buffer.length, dataEnd);
      const audioData = buffer.slice(dataStart, safeEnd);
      const samples = this.extractSamples(audioData, info);

      const fadeSamples = Math.min(Math.floor(referenceInfo.sampleRate * 0.02), Math.floor(samples.length / 4));
      if (fadeSamples > 0) {
        this.applyFade(samples, fadeSamples, {
          fadeIn: index !== 0,
          fadeOut: index !== audioBuffers.length - 1,
        });
      }

      sampleSegments.push(samples);
    }

    // Concatenate segments without spread (avoids stack overflow on large arrays)
    const totalSamples = sampleSegments.reduce((sum, seg) => sum + seg.length, 0);
    const combinedSamples: number[] = new Array<number>(totalSamples);
    let writeIndex = 0;
    for (const segment of sampleSegments) {
      for (let i = 0; i < segment.length; i++) {
        combinedSamples[writeIndex++] = segment[i];
      }
    }

    const normalizedCombined = this.normalizeAudio(combinedSamples);

    return this.createWavBuffer(
      normalizedCombined,
      referenceInfo.sampleRate,
      referenceInfo.channels,
      referenceInfo.bitDepth
    );
  }

  private applyFade(samples: number[], fadeSamples: number, options: { fadeIn?: boolean; fadeOut?: boolean }) {
    const { fadeIn = true, fadeOut = true } = options;

    if (fadeIn) {
      for (let i = 0; i < fadeSamples && i < samples.length; i++) {
        const factor = i / fadeSamples;
        samples[i] *= factor;
      }
    }

    if (fadeOut) {
      for (let i = 0; i < fadeSamples && i < samples.length; i++) {
        const factor = (fadeSamples - i) / fadeSamples;
        const index = samples.length - fadeSamples + i;
        if (index >= 0 && index < samples.length) {
          samples[index] *= factor;
        }
      }
    }
  }

  async generateSpeech(voiceProfileId: string, text: string, requestedBy: string): Promise<string> {
    const voiceProfile = await storage.getVoiceProfile(voiceProfileId);
    if (!voiceProfile) {
      throw new Error("Voice profile not found");
    }

    if (voiceProfile.status !== "ready") {
      throw new Error("Voice profile is not ready for speech generation");
    }

    // Create voice generation record
    const generation = await storage.createVoiceGeneration({
      voiceProfileId,
      text,
      requestedBy,
      status: "processing",
      metadata: {
        createdAt: new Date().toISOString()
      }
    });

    try {
      // Run Chatterbox CLI to synthesize locally
      const audioFileName = `generated-${generation.id}.wav`;
      const audioFilePath = path.join(this.tempDir, audioFileName);
      const audioUrl = `/api/audio/${audioFileName}`;

      const args: string[] = [
        this.chatterboxScript,
        "--text",
        text,
        "--out",
        audioFilePath,
      ];

      const providerRef = (voiceProfile as any).providerRef || (voiceProfile.metadata as any)?.chatterbox?.audioPromptPath;
      if (!providerRef) {
        throw new Error("Voice profile is missing an audio prompt reference for Chatterbox");
      }

      args.push("--speaker-wav", providerRef);
      if (config.CHATTERBOX_DEVICE) args.push("--device", String(config.CHATTERBOX_DEVICE));
      if (config.CHATTERBOX_MULTILINGUAL) args.push("--multilingual");
      if (config.CHATTERBOX_LANGUAGE_ID) args.push("--language", String(config.CHATTERBOX_LANGUAGE_ID));
      if (typeof config.CHATTERBOX_EXAGGERATION === 'number') args.push("--exaggeration", String(config.CHATTERBOX_EXAGGERATION));
      if (typeof config.CHATTERBOX_CFG_WEIGHT === 'number') args.push("--cfg-weight", String(config.CHATTERBOX_CFG_WEIGHT));

      const cliOut = await this.runPython(args);

      // Try to parse CLI JSON (last line) for debug info about prompt usage
      let cliMeta: any = undefined;
      try {
        const lines = (cliOut || '').trim().split('\n');
        const last = lines[lines.length - 1] || '';
        if (last.startsWith('{') && last.endsWith('}')) {
          cliMeta = JSON.parse(last);
        }
      } catch (e) {
        // ignore parse errors; leave cliMeta undefined
      }

      if (cliMeta && (cliMeta.used_prompt_arg || cliMeta.normalized_prompt_path)) {
        console.log('[chatterbox-cli]', {
          used_prompt_arg: cliMeta.used_prompt_arg,
          normalized_prompt_path: cliMeta.normalized_prompt_path,
          out_path: cliMeta.out_path,
          duration_sec: cliMeta.duration_sec,
        });
      }

      await storage.updateVoiceGeneration(generation.id, {
        status: "completed",
        audioUrl,
        metadata: {
          ...(generation.metadata || {}),
          realGeneration: true,
          provider: "CHATTERBOX",
          audioFilePath: audioFilePath,
          completedAt: new Date().toISOString(),
          ...(cliMeta ? { chatterboxCli: cliMeta } : {}),
        }
      });

      return generation.id;
    } catch (error: any) {
      console.error("Chatterbox speech generation error:", error);
      
      // Update generation record with error status
      let errorMessage = "Speech generation failed";
      
      if (String(error?.message || '').toLowerCase().includes('missing dependencies')) {
        errorMessage = "Chatterbox dependencies missing. Please install Python 3, torch, torchaudio, and chatterbox-tts.";
      }

      await storage.updateVoiceGeneration(generation.id, {
        status: "failed",
        metadata: {
          ...(generation.metadata || {}),
          error: errorMessage,
          failedAt: new Date().toISOString()
        }
      });

      throw new Error(`${errorMessage}. Please try again.`);
    }
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

  async getVoiceProfilesByFamily(familyId: string) {
    return await storage.getVoiceProfilesByFamily(familyId);
  }

  async getVoiceProfilesByUser(userId: string) {
    return await storage.getVoiceProfilesByUser(userId);
  }

  async updateVoiceProfileTraining(profileId: string, progress: number) {
    const status = progress >= 100 ? "ready" : "training";
    return await storage.updateVoiceProfile(profileId, {
      trainingProgress: progress,
      status,
    });
  }

  async deleteVoiceProfile(profileId: string) {
    const profile = await storage.getVoiceProfile(profileId);
    if (!profile) {
      throw new Error("Voice profile not found");
    }

    // Attempt to remove associated files (best-effort)
    try {
      if (profile.providerRef) {
        await fs.unlink(profile.providerRef).catch(() => {});
      }
      if (profile.audioSampleUrl && profile.audioSampleUrl.startsWith('/uploads/')) {
        const samplePath = path.join(process.cwd(), profile.audioSampleUrl.replace(/^\/+/, ''));
        await fs.unlink(samplePath).catch(() => {});
      }
    } catch (e) {
      // Ignore file deletion errors
    }

    await storage.deleteVoiceProfile(profileId);
  }

  async getVoiceGeneration(generationId: string) {
    return await storage.getVoiceGeneration(generationId);
  }
  async getVoiceGenerationsByProfile(profileId: string) {
    return await storage.getVoiceGenerationsByProfile(profileId);
  }
}

export const voiceService = new VoiceService();
