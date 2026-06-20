import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';

export function getMediaContentHash(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export async function getPreviewThumbhash(body: Buffer): Promise<string> {
  const { data, info } = await sharp(body)
    .rotate()
    .resize({ width: 100, height: 100, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64');
}
