import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Appends every raw webhook body to data/raw-events.jsonl.
 *
 * This exists so we can design the parser against real Instagram payloads instead
 * of guessing at their shape — share vs reel vs story reply all differ. It is a
 * development aid; in production the same role is played by the `raw_events`
 * table in Supabase.
 */
const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'raw-events.jsonl');

let stream: fs.WriteStream | null = null;

function getStream(): fs.WriteStream {
  if (!stream) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    stream = fs.createWriteStream(FILE, { flags: 'a' });
    stream.on('error', (err) => {
      logger.error('raw event log write failed', { error: err.message });
      stream = null;
    });
  }
  return stream;
}

export function persistRawEvent(body: unknown): void {
  if (!config.PERSIST_RAW_EVENTS) return;
  try {
    getStream().write(`${JSON.stringify({ receivedAt: new Date().toISOString(), body })}\n`);
  } catch (err) {
    // Never let logging break ingestion.
    logger.error('raw event log failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
