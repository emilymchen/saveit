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
   * Where the NAME came from. Deliberately named 'caption' vs 'pixels' rather
   * than 'text' vs 'image': the model read "text" as including on-screen text
   * overlays, which silently bypassed the confirmation gate.
   */
  nameSource: z.enum(['caption', 'pixels']),
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

Rules:
- NEVER produce a street address, and never guess one. Return only the place name and any location hints you can actually see or read. Addresses are resolved afterwards from an authoritative source.
- Only report location hints that are explicitly stated or visible. Do not infer a city from the cuisine, the language on a sign, or the look of a street.
- If no specific place is named anywhere — not on screen, not in the caption, not in the sender's note — return an empty places array. An empty result is correct and useful. A guess is worse than nothing, because it gets silently resolved to a real address somewhere else in the world.
- Set "nameSource" to "caption" ONLY when the name came from the caption, title, or the sender's note — that is, text supplied alongside the post. Set it to "pixels" whenever you read the name off the video or image, INCLUDING on-screen text overlays, signage, menus and watermarks. On-screen text counts as pixels, not caption. Be honest here: it decides whether the save is confirmed with the sender before being kept.
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
    max_tokens: 1024,
    system: SYSTEM,
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
   * know what text we actually supplied — so when none was, provenance can only
   * be the pixels. Don't ask the model for something already known here.
   */
  const hadText = Boolean(signals.userNote) || signals.titles.length > 0;

  return response.parsed_output.places
    .filter((place) => place.placeName !== null)
    .map((place) => (hadText ? place : { ...place, nameSource: 'pixels' as const }))
    .slice(0, MAX_PLACES);
}
