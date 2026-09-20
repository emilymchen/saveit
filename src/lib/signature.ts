import crypto from 'node:crypto';

/**
 * Meta signs every webhook POST with an HMAC-SHA256 of the *raw* request body,
 * keyed by the app secret, and sends it as `X-Hub-Signature-256: sha256=<hex>`.
 *
 * The signature must be computed over the exact bytes Meta sent. Re-serializing
 * the parsed JSON will not reproduce them (key order and whitespace differ), which
 * is why we capture the raw Buffer in the body parser rather than using req.body.
 */
export function isValidSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header) return false;

  const [algorithm, received] = header.split('=');
  if (algorithm !== 'sha256' || !received) return false;

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  // Both are hex strings of the same length, so timingSafeEqual will not throw.
  // Compare in constant time so we do not leak the signature via response timing.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}
