// Browser-only re-encoder. Used for HEIC export and for baking rotation into pixels in Share-safe mode.
// A canvas export carries no EXIF/XMP/ICC at all, which is exactly why it is used here, and why it is lossy.
import { MAX_PIXELS } from './engine/limits.ts';
import { MIME, type Format } from './engine/types.ts';
import type { Rasterizer } from './engine/analyze.ts';

export const rasterize: Rasterizer = async (bytes, from: Format) => {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: MIME[from] }), { imageOrientation: 'from-image' }).catch(() => {
    throw new Error(from === 'heic' ? 'This browser cannot open HEIC. Safari on Mac or iPhone can; Chrome and Firefox usually cannot. Open the file in Safari, or export it as JPEG first.' : 'This browser could not decode the image.');
  });
  try {
    if (bmp.width * bmp.height > MAX_PIXELS) throw new Error('Image is too large to re-encode safely.');
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d')!;
    const lossless = from === 'png';
    if (!lossless) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); } // JPEG has no alpha
    g.drawImage(bmp, 0, 0);
    let blob = await c.convertToBlob(lossless ? { type: 'image/png' } : from === 'webp' ? { type: 'image/webp', quality: 0.92 } : { type: 'image/jpeg', quality: 0.92 });
    if (from === 'webp' && blob.type !== 'image/webp') blob = await c.convertToBlob({ type: 'image/png' }); // browser cannot encode WebP
    return { bytes: new Uint8Array(await blob.arrayBuffer()) };
  } finally { bmp.close(); }
};
