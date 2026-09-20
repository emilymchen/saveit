import { z } from 'zod';

/**
 * Environment is validated once, at boot. A missing secret should crash the
 * process on startup rather than surface as a 403 on a live webhook.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  IG_VERIFY_TOKEN: z.string().min(1, 'IG_VERIFY_TOKEN is required'),
  META_APP_SECRET: z.string().min(1, 'META_APP_SECRET is required'),
  IG_ACCESS_TOKEN: z.string().optional(),
  PERSIST_RAW_EVENTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Both optional so the server still boots and captures raw events during Meta
  // webhook setup, before any parsing keys exist. Parsing skips itself instead.
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
