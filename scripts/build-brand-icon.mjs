import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { brandArtwork } from './brand-artwork.mjs';

// Package the existing LEE T artwork as a multi-resolution Windows icon.
export async function buildBrandIcon(source, target) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const image = await brandArtwork(source);
  const frames = await Promise.all(sizes.map(size => sharp(image).resize(size, size, {
    fit: 'contain', background: '#ffffff',
  }).ensureAlpha().png().toBuffer()));
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + 16 * index;
    header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await writeFile(target, Buffer.concat([header, ...frames]));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildBrandIcon(new URL('../public/brand/lee-t-logo.jpg', import.meta.url),
    new URL('../public/brand/lee-t.ico', import.meta.url));
}
