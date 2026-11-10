/**
 * Compress an image File to a JPEG data-URL ≤ maxBytes (~150KB).
 * Downscale longest edge to 800px — plenty for POS tiles.
 */
export async function fileToPhotoDataUrl(
  file: File,
  maxBytes = 150_000,
): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("not_an_image");
  const bitmap = await createImageBitmap(file);
  const maxEdge = 800;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  // binary-search quality to fit maxBytes
  let lo = 0.3;
  let hi = 0.92;
  let best = canvas.toDataURL("image/jpeg", lo);
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    const url = canvas.toDataURL("image/jpeg", mid);
    if (url.length <= maxBytes) {
      best = url;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (best.length > maxBytes * 1.15) {
    throw new Error("photo_too_large");
  }
  return best;
}
