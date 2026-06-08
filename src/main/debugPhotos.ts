// One-off debug helper to locate where customer photos live in the Yelp Apollo state /
// Thumbtack messenger payloads. Gated behind RH_DEBUG_PHOTOS=1 so it's a no-op normally.
//
//   RH_DEBUG_PHOTOS=1 npm run dev
//   → open / sync a lead that has customer photos
//   → check the terminal for [photo-debug] lines + the dumped JSON path
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Direct image URLs (.jpg/.png/…), with optional query string.
const IMG_URL = /https?:\/\/[^\s"'\\]+?\.(?:jpe?g|png|webp|gif|heic|avif)(?:\?[^\s"'\\]*)?/gi;
// Looser: any https URL whose path hints at media/photos (signed URLs often have no extension).
const MEDIA_HINT = /https?:\/\/[^\s"'\\]*(?:photo|image|media|attachment|thumbnail|cdn|ucarecdn|imgix)[^\s"'\\]*/gi;

export function scanForImages(obj: unknown): string[] {
  const blob = JSON.stringify(obj ?? '');
  const hits = new Set<string>();
  for (const re of [IMG_URL, MEDIA_HINT]) {
    for (const m of blob.matchAll(re)) hits.add(m[0]);
  }
  return [...hits];
}

// Also surface object KEYS that look attachment-ish, to guide where to parse.
function imageKeys(obj: unknown, path = '', out: string[] = []): string[] {
  if (out.length > 40) return out;
  if (Array.isArray(obj)) obj.forEach((v, i) => imageKeys(v, `${path}[${i}]`, out));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (/photo|image|media|attachment|thumbnail|file|asset/i.test(k)) out.push(`${path}.${k}`);
      imageKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}

export function dumpPayload(tag: string, id: string, payload: unknown): void {
  if (process.env.RH_DEBUG_PHOTOS !== '1') return;
  try {
    const file = join(tmpdir(), `replyhawk-${tag}-${id}.json`);
    writeFileSync(file, JSON.stringify(payload, null, 2));
    const urls = scanForImages(payload);
    const keys = imageKeys(payload);
    console.log(`\n[photo-debug ${tag}] lead ${id}`);
    console.log(`  image-like URLs (${urls.length}):`);
    urls.slice(0, 25).forEach((u) => console.log('    •', u));
    if (keys.length) { console.log('  attachment-ish keys:'); keys.slice(0, 25).forEach((k) => console.log('    ·', k)); }
    console.log(`  full payload → ${file}\n`);
  } catch (e) {
    console.warn('[photo-debug] dump failed:', (e as Error).message);
  }
}
