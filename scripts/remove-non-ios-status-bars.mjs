import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const directories = ['app-store-screenshots', 'app-store-screenshots 2'];

for (const directory of directories) {
  const absoluteDirectory = path.join(workspace, directory);
  const names = (await fs.readdir(absoluteDirectory)).filter((name) => name.endsWith('.png'));

  for (const name of names) {
    const filePath = path.join(absoluteDirectory, name);
    const source = sharp(filePath);
    const metadata = await source.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height) continue;

    const stripHeight = Math.max(92, Math.round(height * 0.058));
    const background = width >= 1200
      ? `<linearGradient id="bg" x1="0" y1="0" x2="${width}" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="#0b2934"/><stop offset="0.58" stop-color="#07111b"/><stop offset="1" stop-color="#03040d"/></linearGradient>`
      : '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#05060e"/><stop offset="1" stop-color="#03040d"/></linearGradient>';
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${stripHeight}"><defs>${background}</defs><rect width="${width}" height="${stripHeight}" fill="url(#bg)"/></svg>`);
    const output = await sharp(filePath).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer();
    await fs.writeFile(filePath, output);
  }
}

console.log('Removed platform-specific status-bar artwork from every App Store screenshot size.');
