import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { ImageInput } from './media.js';
import type { SignalBundle } from './signals.js';

/** Cheapest model that can read an image. Swap the id to trade cost for accuracy. */
const MODEL = 'claude-haiku-4-5';
const MAX_PLACES = 5;

export const PlaceCandidateSchema = z.object({
  placeName: z.string().nullable(),
  city: z.string().nullable(),
  neighborhood: z.string().nullable(),
  category: z.string().nullable(),
  cuisine: z.string().nullable(),
  dishes: z.array(z.string()),
  /**
   * Where the NAME came from. Deliberately named 'caption'/'pixels'/'search'
   * rather than 'text'/'image'/'tool': the model read "text" as including
   * on-screen text overlays, which silently bypassed the confirmation gate.
   * 'search' means the caption never stated the name and the model found it
   * via web search (e.g. "the old Principe space in SoHo") — not stated by
   * the poster themselves, so it gets the same confirm-with-sender treatment
   * as a pixels-only guess.
   */
  nameSource: z.enum(['caption', 'pixels', 'search']),
  /** Which signal the name came from, in prose. Invaluable while tuning. */
  evidence: z.string(),
});

const ExtractionSchema = z.object({
  places: z.array(PlaceCandidateSchema),
});

export type PlaceCandidate = z.infer<typeof PlaceCandidateSchema>;

const SYSTEM = `You identify places — restaurants, cafes, bars, bakeries, hotels, attractions — from a social media post that someone saved to visit later.

You may be given any combination of: a note the person wrote when sharing, titles attached to the link, and frames sampled from the post's video or image.

TEXT NAMES THE PLACE. IMAGES CONFIRM IT.

The caption, title, and the sender's note are the authoritative source for the place name — creators nearly always name the venue there. Look there first, and prefer it over anything you read in the images.

Use the images to:
- confirm the name you found in the text
- fill in what the text does not say: category, cuisine, dishes, city
- as a LAST RESORT, name the place when no text names one at all

Naming a place from the pixels alone is error-prone. What looks like the venue's name is very often something else:
- a vendor or sub-brand operating inside it (food halls, markets and multi-vendor spaces make this common)
- the CREATOR'S OWN watermark or handle, often in a corner of every frame
- a supplier, a dish, a neighbouring business, or a brand on packaging

Getting this wrong sends someone to a different restaurant entirely. Prefer returning nothing over naming a venue from an ambiguous sign.

How places are named in captions:
- A 📍 pin emoji marks the venue. The text beside it is the place name — treat that as the answer.
- An @handle is very often the venue itself, e.g. "@commerceinn" or "@cosparamen" -> Commerce Inn, Cospa. Convert it to a readable name. But a caption may also @mention the creator's other accounts or collaborators, usually after "follow" — those are not the venue.
- The name is often in plain prose rather than marked, e.g. "J's Kitchen offers high-quality Japanese cuisine", and may appear at the very END of a long caption. Read all of it.
- If the caption gives a street address, put it in locationHints so the lookup can use it. Never invent one.
- Place names very often look like personal names: Lori Jayne, Frankie's, Tartine, Lucali. Do not dismiss a candidate for reading like a person's name.
- The byline "<Name> on Instagram:" is usually the creator, not the venue — but when a restaurant posts its own food, the byline IS the venue. Judge from context.
- When a brand has several locations, prefer the specific branch if one is identified (e.g. "YOKO-CHO by Suki Desu" or "Jacob's Pickles Moynihan" rather than the parent name), since the address differs per branch.
- Narration phrasing like "this spot", "this place", "they serve" signals a venue is being discussed but does not name it. That alone is not enough.
- Creators often locate a new business by referencing what used to occupy the space, e.g. "the old Principe space in SoHo" or "what used to be Joe's Pizza". The named business is EXPLICITLY EXCLUDED — "old" or "used to be" means it is gone. Never return that name; use web search to find what CURRENTLY occupies that address or space, and if search does not clearly identify a different, current, open business, return nothing rather than the former tenant.

You have a web_search tool. Use it ONLY when the place cannot be named from the caption, note, or images alone — for indirect references like the one above, or to confirm which of several locations of a chain is meant when the caption implies a specific neighborhood but doesn't name it outright. Do not search to double-check a name you are already confident of; that wastes a call. A search-derived name still requires real evidence in the results — do not let the search induce a guess when the results are inconclusive; an empty result is still better than an unconfirmed one.

Rules:
- NEVER produce a street address, and never guess one. Return only the place name and any location hints you can actually see or read. Addresses are resolved afterwards from an authoritative source.
- Only report location hints that are explicitly stated or visible. Do not infer a city from the cuisine, the language on a sign, or the look of a street.
- If no specific place is named anywhere — not on screen, not in the caption, not in the sender's note — return an empty places array. An empty result is correct and useful. A guess is worse than nothing, because it gets silently resolved to a real address somewhere else in the world.
- Set "nameSource" to "caption" ONLY when the name came from the caption, title, or the sender's note — that is, text supplied alongside the post. Set it to "pixels" whenever you read the name off the video or image, INCLUDING on-screen text overlays, signage, menus and watermarks — on-screen text counts as pixels, not caption. Set it to "search" whenever the web_search tool contributed the name. Be honest here: it decides whether the save is confirmed with the sender before being kept.
- In "evidence", state concretely where the name came from, e.g. "neon sign above the door in frame 2", "pin emoji in the caption", or "the sender's note".`;

function describeSignals(signals: SignalBundle, imageCount: number): string {
  const parts: string[] = [];

  if (signals.userNote) parts.push(`Note from the sender:\n${signals.userNote}`);
  if (signals.titles.length > 0) {
    parts.push(`Title(s) attached to the share:\n${signals.titles.join('\n')}`);
  }
  if (imageCount > 0) {
    parts.push(
      imageCount === 1
        ? 'One image from the post is attached above.'
        : `${imageCount} frames sampled across the post's video are attached above, in order.`,
    );
  }
  if (parts.length === 0) parts.push('No usable signal was available.');

  parts.push('Identify the place(s) being recommended.');
  return parts.join('\n\n');
}

export function buildExtractionRequest(signals: SignalBundle, images: ImageInput[]) {
  return {
    model: MODEL,
    // Higher than a text-only call needs: a turn that uses web_search carries
    // the search results plus the model's follow-up reasoning before the
    // final structured output.
    max_tokens: 4096,
    system: SYSTEM,
    tools: [{ type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 2 }],
    messages: [
      {
        role: 'user' as const,
        content: [
          ...images.map((image) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: image.mediaType,
              data: image.base64,
            },
          })),
          { type: 'text' as const, text: describeSignals(signals, images.length) },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  };
}

let client: Anthropic | undefined;

/** Built on first use: the key is optional, and absent during webhook setup. */
function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return client;
}

export async function extractPlaces(
  signals: SignalBundle,
  images: ImageInput[],
): Promise<PlaceCandidate[]> {
  const response = await getClient().messages.parse(buildExtractionRequest(signals, images));

  if (!response.parsed_output) {
    logger.warn('extraction returned no parsable output', { stopReason: response.stop_reason });
    return [];
  }

  /*
   * Reels routinely burn the caption into the video as an overlay, and the
   * model reads that as "caption" however the instruction is worded. But we
   * know what text we actually supplied — so when none was, a claimed
   * "caption" provenance is necessarily wrong and must have been read off the
   * pixels instead. A claimed "search" provenance is left alone even when we
   * supplied no text: the model can legitimately search off something read
   * from an image (e.g. a sign), and that still needs confirmation as
   * 'search' — collapsing it into 'pixels' would just lose the distinction,
   * not add safety, since both are already gated the same way downstream.
   */
  const hadText = Boolean(signals.userNote) || signals.titles.length > 0;

  return response.parsed_output.places
    .filter((place) => place.placeName !== null)
    .map((place) =>
      !hadText && place.nameSource === 'caption' ? { ...place, nameSource: 'pixels' as const } : place,
    )
    .slice(0, MAX_PLACES);
}
