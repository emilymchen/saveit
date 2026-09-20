import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../lib/logger.js';

const run = promisify(execFile);

const MAX_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const FFMPEG_TIMEOUT_MS = 30_000;
const FRAME_COUNT = 4;
/** Claude bills images by area; 768px wide is ~790 tokens and still legible. */
const MAX_WIDTH = 768;

/**
 * Only these hosts are ever fetched. The URLs arrive inside an external webhook
 * payload, so an allowlist — not a blocklist — is what keeps this from becoming
 * a request-forgery primitive pointed at internal services.
 */
const ALLOWED_HOSTS = [
  'cdninstagram.com',
  'fbcdn.net',
  'fbsbx.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
];

export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  base64: string;
}

const IMAGE_TYPES: Record<string, ImageInput['mediaType']> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);

let ffmpegAvailable: boolean | null = null;

async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await run('ffmpeg', ['-version'], { timeout: 5_000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
    logger.warn('ffmpeg not found — video frames will be skipped', {
      hint: 'brew install ffmpeg',
    });
  }
  return ffmpegAvailable;
}

function assertAllowedHost(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new Error(`refusing non-https media url: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  if (!allowed) {
    throw new Error(`refusing media url from non-allowlisted host: ${host}`);
  }
}

/** Downloads to disk with a hard size cap, so a huge response cannot exhaust memory. */
async function download(url: URL, destDir: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`media fetch failed: HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_BYTES) throw new Error(`media too large: ${declared} bytes`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) throw new Error(`media too large: ${buffer.byteLength} bytes`);

  const contentType = res.headers.get('content-type') ?? '';
  const ext =
    path.extname(url.pathname).toLowerCase() ||
    (contentType.startsWith('video/') ? '.mp4' : '.jpg');

  const dest = path.join(destDir, `download${ext}`);
  await fs.writeFile(dest, buffer);
  return dest;
}

async function probeDuration(file: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { timeout: FFMPEG_TIMEOUT_MS },
    );
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/**
 * Samples frames across the whole clip rather than the opening seconds —
 * creators routinely put the place name on a card at the very end.
 */
async function extractFrames(video: string, workDir: string): Promise<string[]> {
  const duration = await probeDuration(video);
  const timestamps = duration
    ? Array.from({ length: FRAME_COUNT }, (_, i) => (duration * (i + 0.5)) / FRAME_COUNT)
    : [1];

  const frames: string[] = [];
  for (const [i, at] of timestamps.entries()) {
    const out = path.join(workDir, `frame${i}.jpg`);
    try {
      await run(
        'ffmpeg',
        // -ss before -i seeks without decoding everything up to that point.
        ['-nostdin', '-y', '-ss', at.toFixed(2), '-i', video,
          '-frames:v', '1', '-vf', `scale='min(${MAX_WIDTH},iw)':-2`, '-q:v', '3', out],
        { timeout: FFMPEG_TIMEOUT_MS },
      );
      const stat = await fs.stat(out);
      if (stat.size > 0) frames.push(out);
    } catch {
      // A seek past the end of a short clip is expected; other frames still work.
    }
  }
  return frames;
}

async function shrinkImage(image: string, workDir: string): Promise<string> {
  const out = path.join(workDir, 'shrunk.jpg');
  await run(
    'ffmpeg',
    ['-nostdin', '-y', '-i', image, '-vf', `scale='min(${MAX_WIDTH},iw)':-2`, '-q:v', '3', out],
    { timeout: FFMPEG_TIMEOUT_MS },
  );
  return out;
}

async function toImageInput(file: string): Promise<ImageInput> {
  const ext = path.extname(file).toLowerCase();
  return {
    mediaType: IMAGE_TYPES[ext] ?? 'image/jpeg',
    base64: (await fs.readFile(file)).toString('base64'),
  };
}

function isRemote(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/**
 * Turns media sources — remote CDN URLs or local file paths — into image blocks.
 *
 * Every source is independent: one failure logs and is skipped rather than
 * failing the whole parse. A CDN URL is fetched immediately because Instagram's
 * expire within hours; there is no deferring this step.
 */
export async function collectImages(sources: string[]): Promise<ImageInput[]> {
  const images: ImageInput[] = [];

  for (const source of sources) {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'saveit-media-'));
    try {
      let file: string;
      if (isRemote(source)) {
        const url = new URL(source);
        assertAllowedHost(url);
        file = await download(url, workDir);
      } else {
        file = path.resolve(source);
        await fs.access(file);
      }

      const ext = path.extname(file).toLowerCase();
      const ffmpeg = await hasFfmpeg();

      if (VIDEO_EXTS.has(ext)) {
        if (!ffmpeg) continue;
        for (const frame of await extractFrames(file, workDir)) {
          images.push(await toImageInput(frame));
        }
      } else if (ffmpeg) {
        images.push(await toImageInput(await shrinkImage(file, workDir)));
      } else {
        // Without ffmpeg we send the original bytes — costlier, still correct.
        images.push(await toImageInput(file));
      }
    } catch (err) {
      logger.warn('skipped media source', {
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  return images;
}
