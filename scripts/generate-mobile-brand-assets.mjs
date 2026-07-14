import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imageDir = path.join(root, 'ugc-mobile', 'assets', 'images');

function iconSvg({ transparent = false } = {}) {
  const background = transparent
    ? ''
    : '<rect width="1024" height="1024" fill="url(#background)"/>';
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs>
        <linearGradient id="background" x1="110" y1="96" x2="910" y2="940" gradientUnits="userSpaceOnUse">
          <stop stop-color="#281044"/>
          <stop offset="0.48" stop-color="#5b1b89"/>
          <stop offset="1" stop-color="#101012"/>
        </linearGradient>
        <linearGradient id="book" x1="266" y1="300" x2="770" y2="748" gradientUnits="userSpaceOnUse">
          <stop stop-color="#fff8ed"/>
          <stop offset="1" stop-color="#ffd6cb"/>
        </linearGradient>
        <linearGradient id="spark" x1="692" y1="194" x2="824" y2="358" gradientUnits="userSpaceOnUse">
          <stop stop-color="#ffb09b"/>
          <stop offset="1" stop-color="#ff7a59"/>
        </linearGradient>
        <filter id="shadow" x="128" y="160" width="768" height="704" filterUnits="userSpaceOnUse">
          <feDropShadow dx="0" dy="28" stdDeviation="34" flood-color="#08030f" flood-opacity="0.42"/>
        </filter>
      </defs>
      ${background}
      <g filter="url(#shadow)">
        <path d="M222 334c0-35 29-64 64-64h170c43 0 78 17 104 47v428c-28-24-61-36-101-36H286c-35 0-64-29-64-64V334Z" fill="url(#book)"/>
        <path d="M802 334c0-35-29-64-64-64H568c-43 0-78 17-104 47v428c28-24 61-36 101-36h173c35 0 64-29 64-64V334Z" fill="#f6e9ff"/>
        <path d="M464 318v427" stroke="#cf8df1" stroke-width="18" stroke-linecap="round"/>
        <path d="M286 411h112M286 487h112M626 411h112M626 487h112" stroke="#5b1b89" stroke-width="22" stroke-linecap="round" opacity="0.55"/>
      </g>
      <path d="M744 180c9 77 44 112 121 121-77 9-112 44-121 121-9-77-44-112-121-121 77-9 112-44 121-121Z" fill="url(#spark)"/>
      <circle cx="846" cy="192" r="26" fill="#fff8ed"/>
    </svg>`;
}

await sharp(Buffer.from(iconSvg())).png().toFile(path.join(imageDir, 'icon.png'));
await sharp(Buffer.from(iconSvg({ transparent: true }))).png().toFile(path.join(imageDir, 'adaptive-icon.png'));
await sharp(Buffer.from(iconSvg({ transparent: true }))).resize(640, 640).png().toFile(path.join(imageDir, 'splash-icon.png'));
await sharp(Buffer.from(iconSvg())).resize(96, 96).png().toFile(path.join(imageDir, 'favicon.png'));

console.log('Generated consistent Magic Booklet icon, adaptive icon, splash icon, and favicon.');
