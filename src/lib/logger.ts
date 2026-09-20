import { isProd } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const time = new Date().toISOString();

  // Production logs are single-line JSON so a log aggregator can index them.
  if (isProd) {
    console.log(JSON.stringify({ time, level, msg, ...meta }));
    return;
  }

  const tail = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  console.log(`${COLORS[level]}${level.toUpperCase().padEnd(5)}\x1b[0m ${msg}${tail}`);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
