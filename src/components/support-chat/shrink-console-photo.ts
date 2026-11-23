'use client';

import {
  SUPPORT_CONSOLE_PHOTO_MAX_BYTES,
  SUPPORT_CONSOLE_PHOTO_MAX_SIDE,
} from '../../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

const TOO_LARGE = 'That photo is too large to send. Choose a smaller one.';

/**
 * The console's photo, small enough to go with its send: the host refuses a
 * request over about 4.5 MB, so a picture over the console's cap is drawn
 * again at up to 2560 px a side (upright, as the browser shows it) and saved
 * as JPEG, a little lower each time until it fits. One already under the cap
 * goes as it is; the server re-encodes every photo anyway.
 */
export async function shrinkConsolePhoto(
  file: Blob,
  {
    maxSide = SUPPORT_CONSOLE_PHOTO_MAX_SIDE,
    maxBytes = SUPPORT_CONSOLE_PHOTO_MAX_BYTES,
  }: { maxSide?: number; maxBytes?: number } = {},
): Promise<Blob> {
  if (file.size <= maxBytes) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(TOO_LARGE);
  }

  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error(TOO_LARGE);
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.9, 0.82, 0.74, 0.66]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= maxBytes) return blob;
  }
  throw new Error(TOO_LARGE);
}
