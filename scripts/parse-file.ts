#!/usr/bin/env tsx
/**
 * Runs the parsing pipeline against a local post file, with no Meta app, no
 * tunnel and no webhook. This is the tight loop for tuning the prompt and
 * schema: download a real reel or post, point this at it, see what comes back.
 *
 * Usage:
 *   npm run parse -- ./fixtures/tacos.mp4
 *   npm run parse -- ./fixtures/tacos.mp4 --note "need to try this"
 *   npm run parse -- ./fixtures/tacos.mp4 --dry-run
 *
 * A sidecar <file>.json of { "title": "...", "note": "..." } is picked up
 * automatically, so a fixture can carry its real caption alongside it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildExtractionRequest } from '../src/parse/extract.js';
import { parseSignals } from '../src/parse/index.js';
import { collectImages } from '../src/parse/media.js';
import type { SignalBundle } from '../src/parse/signals.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

if (!file) {
  console.error('Usage: npm run parse -- <file> [--note "..."] [--title "..."] [--dry-run]');
  process.exit(1);
}

const target = path.resolve(file);
await fs.access(target).catch(() => {
  console.error(`No such file: ${target}`);
  process.exit(1);
});

// Sidecar lets a fixture carry its real caption without retyping it each run.
let sidecar: { title?: string; note?: string } = {};
const sidecarPath = `${target}.json`;
try {
  sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
} catch {
  // Optional.
}

const title = flag('title') ?? sidecar.title;
const signals: SignalBundle = {
  userNote: flag('note') ?? sidecar.note ?? null,
  titles: title ? [title] : [],
  media: [target],
  permalinks: [],
};

console.log(`\n${path.basename(target)}`);
console.log(`  note:  ${signals.userNote ?? '(none)'}`);
console.log(`  title: ${title ?? '(none)'}\n`);

if (dryRun) {
  const images = await collectImages(signals.media);
  const request = buildExtractionRequest(signals, images);
  const blocks = request.messages[0]!.content;
  const text = blocks.find((b) => b.type === 'text');

  console.log(`model:  ${request.model}`);
  console.log(`images: ${images.length}`);
  for (const [i, image] of images.entries()) {
    console.log(`  [${i}] ${image.mediaType}, ${Math.round(image.base64.length / 1365)} KB`);
  }
  console.log(`\n--- prompt ---\n${text && 'text' in text ? text.text : ''}\n`);
  console.log('Dry run — nothing sent, nothing spent.');
  process.exit(0);
}

const result = await parseSignals(signals);

if (result.needsFollowup && result.places.length === 0) {
  console.log(`No place identified (${result.reason}).`);
  process.exit(0);
}

for (const { candidate, resolved } of result.places) {
  console.log(`  ${candidate.placeName}`);
  console.log(`    address:  ${resolved?.address ?? '(unresolved)'}`);
  console.log(`    from:     ${candidate.nameSource}`);
  console.log(`    category: ${candidate.category ?? '-'} / ${candidate.cuisine ?? '-'}`);
  if (candidate.dishes.length > 0) console.log(`    dishes:   ${candidate.dishes.join(', ')}`);
  console.log(`    evidence: ${candidate.evidence}\n`);
}

if (result.needsFollowup) {
  console.log(`  ⚠ needs follow-up with the sender (${result.reason})`);
}
