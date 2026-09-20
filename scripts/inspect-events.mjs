#!/usr/bin/env node
/**
 * Pretty-prints captured webhook payloads from data/raw-events.jsonl.
 *
 * Purpose: answer "what does a real Instagram share actually contain?" before we
 * build the parser around assumptions. It deep-scans each payload for URLs
 * wherever they appear, since Meta nests them differently per attachment type.
 *
 * Usage:
 *   npm run events                 # summary of every captured event
 *   npm run events -- --last       # full JSON of the most recent event
 *   npm run events -- --urls       # just the URLs found, deduped
 *   npm run events -- --watch      # live: print new events as they arrive
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const FILE = path.resolve(process.cwd(), 'data', 'raw-events.jsonl');

const C = {
  dim: '\x1b[90m', bold: '\x1b[1m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m', reset: '\x1b[0m',
};

/** Walk any nested structure and collect every string that looks like a URL. */
function findUrls(node, found = new Map(), trail = []) {
  if (typeof node === 'string') {
    if (/^https?:\/\//i.test(node)) {
      const at = trail.join('.');
      if (!found.has(node)) found.set(node, at);
    }
    return found;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => findUrls(v, found, [...trail, String(i)]));
    return found;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) findUrls(v, found, [...trail, k]);
  }
  return found;
}

/** Is this the shareable permalink (what we can actually re-open later)? */
function isPermalink(url) {
  return /instagram\.com\/(p|reel|reels|tv)\//i.test(url) || /tiktok\.com\/.+\/video\//i.test(url);
}

/** Is this a short-lived CDN media file rather than a durable link? */
function isCdnMedia(url) {
  return /cdninstagram\.com|fbcdn\.net|tiktokcdn/i.test(url);
}

function describe(record, index) {
  const body = record.body ?? record;
  const events = (body.entry ?? []).flatMap((e) => e.messaging ?? []);

  for (const ev of events) {
    const m = ev.message ?? {};
    const tags = [];
    if (m.is_echo) tags.push(`${C.dim}echo${C.reset}`);
    if (m.is_unsupported) tags.push(`${C.red}unsupported${C.reset}`);
    if (m.reply_to?.story) tags.push(`${C.yellow}story-reply${C.reset}`);

    console.log(`${C.bold}#${index}${C.reset} ${C.dim}${record.receivedAt ?? ''}${C.reset} ${tags.join(' ')}`);
    console.log(`   from IGSID : ${ev.sender?.id ?? '?'}`);
    console.log(`   mid        : ${C.dim}${m.mid ?? '?'}${C.reset}`);
    console.log(`   text       : ${m.text ? JSON.stringify(m.text) : `${C.dim}(none)${C.reset}`}`);

    const atts = m.attachments ?? [];
    console.log(
      `   attachments: ${atts.length ? atts.map((a) => a.type ?? '?').join(', ') : `${C.dim}(none)${C.reset}`}`,
    );

    const urls = findUrls(ev);
    if (urls.size === 0) {
      console.log(`   urls       : ${C.dim}(none)${C.reset}`);
    } else {
      console.log('   urls       :');
      for (const [url, at] of urls) {
        let kind = `${C.dim}other${C.reset}`;
        if (isPermalink(url)) kind = `${C.green}PERMALINK${C.reset}`;
        else if (isCdnMedia(url)) kind = `${C.yellow}cdn-media${C.reset}`;
        const shown = url.length > 110 ? `${url.slice(0, 110)}…` : url;
        console.log(`     [${kind}] ${C.dim}${at}${C.reset}`);
        console.log(`       ${shown}`);
      }
    }
    console.log();
  }
}

function readRecords() {
  if (!fs.existsSync(FILE)) {
    console.error(`No capture file at ${FILE}.`);
    console.error('Start the server with PERSIST_RAW_EVENTS=true and send it a DM.');
    process.exit(1);
  }
  return fs
    .readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        console.error(`${C.red}line ${i + 1} is not valid JSON, skipping${C.reset}`);
        return null;
      }
    })
    .filter(Boolean);
}

const args = process.argv.slice(2);

if (args.includes('--watch')) {
  // Tail the file and describe each new line as it lands.
  console.log(`${C.cyan}watching ${FILE} — send a DM to the bot now${C.reset}\n`);
  let offset = fs.existsSync(FILE) ? fs.statSync(FILE).size : 0;
  let n = 0;
  setInterval(() => {
    if (!fs.existsSync(FILE)) return;
    const size = fs.statSync(FILE).size;
    if (size <= offset) return;
    const chunk = fs.createReadStream(FILE, { start: offset, end: size - 1, encoding: 'utf8' });
    offset = size;
    readline.createInterface({ input: chunk }).on('line', (line) => {
      if (!line.trim()) return;
      try {
        describe(JSON.parse(line), ++n);
      } catch {
        /* partial line; next tick picks it up */
      }
    });
  }, 500);
} else if (args.includes('--last')) {
  const records = readRecords();
  const last = records.at(-1);
  if (!last) { console.log('No events captured yet.'); process.exit(0); }
  console.log(JSON.stringify(last, null, 2));
} else if (args.includes('--urls')) {
  const all = new Map();
  for (const r of readRecords()) for (const [u, at] of findUrls(r.body ?? r)) all.set(u, at);
  if (all.size === 0) console.log('No URLs found in any captured event.');
  for (const [u, at] of all) console.log(`${isPermalink(u) ? `${C.green}PERMALINK${C.reset}` : isCdnMedia(u) ? `${C.yellow}cdn-media${C.reset}` : 'other    '}  ${C.dim}${at}${C.reset}\n  ${u}`);
} else {
  const records = readRecords();
  if (records.length === 0) { console.log('No events captured yet.'); process.exit(0); }
  console.log(`${C.bold}${records.length} captured payload(s)${C.reset}\n`);
  records.forEach((r, i) => describe(r, i + 1));
}
