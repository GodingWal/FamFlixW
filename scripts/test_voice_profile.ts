#!/usr/bin/env -S node --enable-source-maps
import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { storage } from '../server/storage';
import { voiceService } from '../server/services/voiceService';

async function ensureLongPrompt(pythonBin: string, outPath: string) {
  try {
    await fs.access(outPath);
    const st = await fs.stat(outPath);
    if (st.size > 300_000) return; // ~>3s at 96KB/s rough
  } catch (e) {
    // If the file is missing or too small, we will (re)generate it below.
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const text = 'This is a longer sample for the Chatterbox text to speech system. We will continue speaking for several seconds to ensure the duration exceeds the minimum required length. This test verifies end-to-end voice cloning and synthesis.';
  const args = [
    path.resolve(process.cwd(), 'scripts/chatterbox_tts.py'),
    '--text', text,
    '--out', outPath,
    '--device', process.env.CHATTERBOX_DEVICE || 'cpu',
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(pythonBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`CLI failed (${code}): ${err || out}`));
    });
  });
}

async function main() {
  const pythonBin = process.env.PYTHON_BIN || 'python3';
  const dbUrl = process.env.DATABASE_URL || 'file:./famflix.db';
  if (!dbUrl.startsWith('file:')) {
    console.error('[test] This script expects SQLite (file:). DATABASE_URL=', dbUrl);
  }

  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  const tempDir = path.resolve(process.cwd(), 'temp');
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  const promptPath = path.join(tempDir, 'cb-prompt.wav');
  await ensureLongPrompt(pythonBin, promptPath);
  const promptBuf = await fs.readFile(promptPath);

  // Create test user
  const ts = Date.now().toString(36);
  const email = `cbtest+${ts}@local.test`;
  const username = `cbuser_${ts}`;
  const user = await storage.createUser({
    username,
    email,
    password: crypto.randomBytes(12).toString('hex'),
    firstName: 'CB',
    lastName: 'Test',
    avatar: null as any,
    role: 'user' as any,
    plan: 'free' as any,
    planRenewalAt: null as any,
    isActive: true as any,
    isEmailVerified: true as any,
    emailVerifiedAt: new Date() as any,
  } as any);

  // Create voice profile
  const name = `Chatter Voice ${ts}`;
  const profileId = await voiceService.createVoiceClone(promptBuf, name, user.id);
  const profile = await storage.getVoiceProfile(profileId);

  // Generate speech
  const text = 'Hello from the Chatterbox integration end to end test. This audio should be generated locally.';
  const generationId = await voiceService.generateSpeech(profileId, text, user.id);
  const generation = await storage.getVoiceGeneration(generationId);

  console.log(JSON.stringify({
    ok: true,
    userId: user.id,
    profileId,
    profile,
    generation,
  }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }));
  process.exit(1);
});
