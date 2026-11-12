import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { brandArtwork } from './brand-artwork.mjs';

// Package the existing LEE T artwork as a multi-resolution Windows icon.
export async function buildBrandIcon(source, target) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const image = await brandArtwork(source);
  const frames = await Promise.all(sizes.map(async size => {
    const raster = sharp(image).resize(size, size, { fit: 'contain', background: '#ffffff' }).ensureAlpha();
    if (size === 256) return raster.png().toBuffer();
    // Native 32-bit DIB frames avoid differences between the shell and GDI+
    // loaders for small PNG-compressed icons. Keep PNG for the 256px frame.
    const rgba = await raster.raw().toBuffer();
    const maskStride = Math.ceil(size / 32) * 4;
    const dib = Buffer.alloc(40 + size * size * 4 + maskStride * size);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(size, 4); dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14);
    dib.writeUInt32LE(size * size * 4, 20);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4;
      const target = 40 + ((size - 1 - y) * size + x) * 4;
      dib[target] = rgba[source + 2]; dib[target + 1] = rgba[source + 1];
      dib[target + 2] = rgba[source]; dib[target + 3] = rgba[source + 3];
    }
    return dib;
  }));
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
