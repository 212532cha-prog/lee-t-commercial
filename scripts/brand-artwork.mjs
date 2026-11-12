import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

// The supplied logo is presentation artwork with wide margins. Package its
// original central mark (including its shadow), rather than shrinking the poster.
export async function brandArtwork(source) {
  const image = sharp(await readFile(source));
  const metadata = await image.metadata();
  if (metadata.width !== 2048 || metadata.height !== 1143) {
    throw Error('LEE T source artwork changed; review the launcher crop before packaging.');
  }
  return image.extract({ left: 660, top: 240, width: 730, height: 620 }).png().toBuffer();
}
