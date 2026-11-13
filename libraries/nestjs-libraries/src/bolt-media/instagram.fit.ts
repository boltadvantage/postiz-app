// Bolt Advantage: Instagram only takes feed images from 4:5 (portrait) to
// 1.91:1 (landscape). Rather than failing the post, pad an off-shape image
// with its own main color so the whole picture fits, and send Instagram that
// copy as a JPEG (the only image type its API takes). Other channels keep the
// original. Anything that goes wrong leaves the image as it was.
import sharp from 'sharp';
import { resolve, sep } from 'path';
import { readFile } from 'fs/promises';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { isSafePublicHttpsUrl } from '@gitroom/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import { ssrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';

export const IG_MIN_RATIO = 4 / 5;
export const IG_MAX_RATIO = 1.91;

/** The padded size for an off-shape image, or null when it already fits. */
export function instagramSize(width: number, height: number) {
  if (!width || !height) return null;
  const ratio = width / height;
  if (ratio < IG_MIN_RATIO - 0.001) return { width: Math.ceil(height * IG_MIN_RATIO), height };
  if (ratio > IG_MAX_RATIO + 0.001) return { width, height: Math.ceil(width / IG_MAX_RATIO) };
  return null;
}

/** Our own uploads are read from disk; anything else is fetched like any outside URL. */
async function readMedia(url: string) {
  const prefix = `${process.env.FRONTEND_URL}/uploads/`;
  const dir = process.env.UPLOAD_DIRECTORY;
  if (dir && url.startsWith(prefix)) {
    const root = resolve(dir);
    const file = resolve(root, decodeURIComponent(url.slice(prefix.length).split('?')[0]));
    if (file.startsWith(root + sep)) {
      try {
        return await readFile(file);
      } catch {
        // not on this disk (another container); fall through to fetching it
      }
    }
  }
  if (!(await isSafePublicHttpsUrl(url))) throw new Error('Unsafe URL');
  // @ts-ignore — undici option, not in lib.dom fetch types
  const res = await fetch(url, { dispatcher: ssrfSafeDispatcher, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Pads `buffer` to Instagram's range; returns null when it already fits. */
export async function padForInstagram(buffer: Buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  // phone photos are often stored sideways with an EXIF turn
  const turned = (meta.orientation || 1) >= 5;
  const width = turned ? meta.height! : meta.width!;
  const height = turned ? meta.width! : meta.height!;
  const size = instagramSize(width, height);
  if (!size) return null;
  const { dominant } = await sharp(buffer, { failOn: 'none' }).stats();
  const background = { r: dominant.r, g: dominant.g, b: dominant.b, alpha: 1 };
  const left = Math.floor((size.width - width) / 2);
  const top = Math.floor((size.height - height) / 2);
  return sharp(buffer, { failOn: 'none' })
    .rotate()
    .extend({ left, right: size.width - width - left, top, bottom: size.height - height - top, background })
    .flatten({ background })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

/** The image to send Instagram: the original, or a padded copy saved next to it. */
export async function fitForInstagram(url: string, log?: (msg: string) => void) {
  try {
    const padded = await padForInstagram(await readMedia(url));
    if (!padded) return url;
    return await UploadFactory.createStorage().uploadSimple(`data:image/jpeg;base64,${padded.toString('base64')}`);
  } catch (err: any) {
    log?.(`Instagram image fit skipped for ${url}: ${err?.message || err}`);
    return url;
  }
}
