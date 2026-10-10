import { execFile, type ExecFileOptions } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffmpegPath: string = require('ffmpeg-static');

function execFileP(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string });
      }
    });
  });
}

const HANDY_BIN = process.env.HANDY_BIN || '/usr/bin/handy';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const DOWNLOAD_TIMEOUT_MS = 30_000; // 30s for Discord CDN download
const FFMPEG_TIMEOUT_MS = 30_000;
const HANDY_TIMEOUT_MS = Number(process.env.HANDY_TIMEOUT_MS || 120_000);

export function isVoiceEnabled(): boolean {
  return existsSync(HANDY_BIN);
}

export function getHandyBin(): string {
  return HANDY_BIN;
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function extractJson(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Handy did not return JSON output');
  }
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

export async function transcribe(attachmentUrl: string, fileSize?: number): Promise<string> {
  if (fileSize && fileSize > MAX_FILE_SIZE) {
    throw new Error('File size exceeds 25MB limit');
  }

  if (!existsSync(HANDY_BIN)) {
    throw new Error(`Handy binary not found: ${HANDY_BIN}`);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'opencode-handy-'));
  const inputPath = join(tmpDir, 'voice.ogg');
  const wavPath = join(tmpDir, 'voice.wav');

  try {
    // Download audio from Discord CDN
    const audioResponse = await fetchWithTimeout(attachmentUrl, {}, DOWNLOAD_TIMEOUT_MS);
    if (!audioResponse.ok) {
      throw new Error(`Failed to download audio: HTTP ${audioResponse.status}`);
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    writeFileSync(inputPath, audioBuffer);

    // Convert to 16 kHz mono WAV (Handy input format)
    await execFileP(
      ffmpegPath,
      ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath],
      { timeout: FFMPEG_TIMEOUT_MS },
    );

    const args = ['--transcribe-file', wavPath, '--json'];
    const model = process.env.HANDY_MODEL;
    if (model) {
      args.push('--model', model);
    }

    const { stdout } = await execFileP(HANDY_BIN, args, {
      timeout: HANDY_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });

    const parsed = extractJson(stdout);
    const text = (parsed.text ?? '').toString().trim();
    if (!text) {
      throw new Error('Handy returned empty transcription');
    }
    return text;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
