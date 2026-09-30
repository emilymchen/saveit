import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { PlaceCandidate } from './extract.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const TIMEOUT_MS = 8_000;
/** Places bills by field tier — ask for nothing beyond what we store. */
const FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus';

export interface ResolvedPlace {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

interface TextSearchResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
  }>;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Text Search returns a confident-looking result for almost any query, so a
 * miss looks identical to a hit. Requiring the returned name to share most of
 * the extracted name's words is what stops us saving a real address for the
 * wrong restaurant — the failure a user would never think to double-check.
 */
export function namesMatch(extracted: string, returned: string): boolean {
  const wanted = tokenize(extracted);
  const got = new Set(tokenize(returned));
  if (wanted.length === 0 || got.size === 0) return false;

  /*
   * Businesses are inconsistent about spacing their own name: a caption saying
   * "Sour Aji" resolves to a Places listing called "SourAji" at exactly the
   * address the caption gave, and token overlap scores that zero. Compare the
   * punctuation- and space-stripped forms too. Equality only, not containment —
   * containment would let "Bar" match "Barcelona".
   */
  if (squash(extracted) === squash(returned)) return true;

  const hits = wanted.filter((token) => got.has(token)).length;
  return hits / wanted.length >= 0.5;
}

/** Lowercased, de-accented, stripped of everything but letters and digits. */
function squash(value: string): string {
  return tokenize(value).join('');
}

function buildQuery(candidate: PlaceCandidate): string {
  return [candidate.placeName, candidate.neighborhood, candidate.city]
    .filter(Boolean)
    .join(', ');
}

export async function resolvePlace(candidate: PlaceCandidate): Promise<ResolvedPlace | null> {
  if (!config.GOOGLE_MAPS_API_KEY) {
    logger.warn('place resolution skipped: GOOGLE_MAPS_API_KEY is not set');
    return null;
  }
  if (!candidate.placeName) return null;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': config.GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: buildQuery(candidate), maxResultCount: 1 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    logger.error('places text search failed', { status: res.status, body: await res.text() });
    return null;
  }

  const body = (await res.json()) as TextSearchResponse;
  const top = body.places?.[0];
  if (!top?.id || !top.formattedAddress || !top.displayName?.text) return null;

  if (!namesMatch(candidate.placeName, top.displayName.text)) {
    logger.info('rejected places result: name mismatch', {
      extracted: candidate.placeName,
      returned: top.displayName.text,
    });
    return null;
  }

  /*
   * A permanently closed result is a real address for a place that no longer
   * exists — confident-looking and completely useless. Surfaced concretely by
   * a caption describing "the old Principe space": web search found the
   * former tenant, Places confirmed a real business status, and without this
   * check we'd have silently saved a dead restaurant. Temporarily closed is
   * left alone; this app saves places to visit LATER, and one may reopen.
   */
  if (top.businessStatus === 'CLOSED_PERMANENTLY') {
    logger.info('rejected places result: permanently closed', {
      extracted: candidate.placeName,
      returned: top.displayName.text,
    });
    return null;
  }

  return {
    placeId: top.id,
    name: top.displayName.text,
    address: top.formattedAddress,
    latitude: top.location?.latitude ?? 0,
    longitude: top.location?.longitude ?? 0,
  };
}
