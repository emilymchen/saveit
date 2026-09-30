import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { getSupabase } from '../lib/supabase.js';

export const savesRouter: Router = Router();

/**
 * HTTP Basic Auth against a single shared password — no session/cookie
 * machinery, no new dependency. This is the internal viewer until real
 * per-user auth exists; a raw `?igsid=` filter alone would only be
 * security-by-obscurity (IGSIDs aren't secret, just unguessable-ish).
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('authorization');
  const password = header?.startsWith('Basic ')
    ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')[1]
    : undefined;

  if (password && timingSafeStringEqual(password, config.ADMIN_VIEW_PASSWORD)) {
    next();
    return;
  }

  res.set('WWW-Authenticate', 'Basic realm="saveit-internal"');
  res.sendStatus(401);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/** Prevents place names / evidence / captions (all attacker-influenced, from Instagram) from being interpreted as HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface SaveRow {
  id: string;
  sender_igsid: string;
  place_name: string;
  name_source: string;
  category: string | null;
  cuisine: string | null;
  evidence: string;
  resolved: boolean;
  address: string | null;
  place_id: string | null;
  created_at: string;
  messages: { sent_at: string; text: string | null } | null;
}

function renderPage(rows: SaveRow[], igsidFilter: string | undefined): string {
  const body =
    rows.length === 0
      ? '<p>No saves yet.</p>'
      : `<table>
          <thead><tr>
            <th>When</th><th>Sender</th><th>Place</th><th>Address</th>
            <th>Source</th><th>Evidence</th>
          </tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr>
                  <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
                  <td><a href="/saves?igsid=${encodeURIComponent(r.sender_igsid)}">${escapeHtml(r.sender_igsid)}</a></td>
                  <td>${escapeHtml(r.place_name)}${r.resolved ? '' : ' <em>(unresolved)</em>'}</td>
                  <td>${r.address ? escapeHtml(r.address) : '—'}</td>
                  <td>${escapeHtml(r.name_source)}</td>
                  <td>${escapeHtml(r.evidence)}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>SaveIt — saves</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.4rem 0.8rem; border-bottom: 1px solid #ddd; font-size: 0.9rem; }
  th { background: #f5f5f5; }
</style></head>
<body>
  <h1>Saves${igsidFilter ? ` — ${escapeHtml(igsidFilter)}` : ''}</h1>
  ${igsidFilter ? '<p><a href="/saves">← all senders</a></p>' : ''}
  ${body}
</body></html>`;
}

savesRouter.get('/', requireAdmin, async (req: Request, res: Response) => {
  const igsid = typeof req.query.igsid === 'string' ? req.query.igsid : undefined;

  let query = getSupabase()
    .from('saves')
    .select('*, messages(sent_at, text)')
    .order('created_at', { ascending: false })
    .limit(200);

  if (igsid) query = query.eq('sender_igsid', igsid);

  const { data, error } = await query;

  if (error) {
    res.status(500).send(`Query failed: ${escapeHtml(error.message)}`);
    return;
  }

  res.type('html').send(renderPage((data ?? []) as SaveRow[], igsid));
});
