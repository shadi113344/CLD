// Small local copies of post images. Instagram's image links stop working
// after a few days, so Stash keeps a ~320px WebP of each one (typically
// 10–30 KB). Runs in the service worker, whose host permission for
// Instagram's image servers lets it read the image.

const MAX_SIDE = 320;
const KEEP_UNSHRUNK = 150 * 1024; // if shrinking fails, keep originals up to this size

export async function makeThumb(url) {
  const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`image server returned ${res.status}`);
  const blob = await res.blob();
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const width = Math.max(1, Math.round(bmp.width * scale));
    const height = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, width, height);
    bmp.close();
    const small = await canvas.convertToBlob({ type: 'image/webp', quality: 0.72 });
    return { blob: small.size < blob.size ? small : blob, width, height };
  } catch (e) {
    if (blob.size <= KEEP_UNSHRUNK && /^image\//.test(blob.type)) return { blob, width: 0, height: 0 };
    throw e;
  }
}
