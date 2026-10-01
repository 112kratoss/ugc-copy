import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

async function manifests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? manifests(path.join(directory, entry.name))
    : entry.name.endsWith('.nft.json') ? [path.join(directory, entry.name)] : []))).flat();
}
const require = createRequire(import.meta.url);
const { flockSync } = require('fs-ext');
const root = mkdtempSync(path.join(tmpdir(), 'staging-lock-build-'));
let first, second;
try {
  first = openSync(path.join(root, 'lease'), 'wx+');
  second = openSync(path.join(root, 'lease'), 'r+');
  flockSync(first, 'exnb');
  let denied = false;
  try { flockSync(second, 'exnb'); }
  catch (error) { if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) denied = true; else throw error; }
  if (!denied) throw new Error('Native staging lock does not exclude a separate descriptor.');
  closeSync(first); first = undefined;
  flockSync(second, 'exnb');
} finally {
  if (first !== undefined) closeSync(first);
  if (second !== undefined) closeSync(second);
  rmSync(root, { recursive: true, force: true });
}
let traced = 0;
for (const manifest of await manifests('.next/server')) {
  const { files } = JSON.parse(await readFile(manifest, 'utf8'));
  const loader = files.find((file) => /\/fs-ext\/fs-ext\.js$/.test(file));
  if (!loader) continue;
  const binding = files.find((file) => /\/fs-ext\/build\/Release\/fs_ext\.node$/.test(file));
  if (!binding) throw new Error(`Native staging lock missing from ${manifest}`);
  await access(path.resolve(path.dirname(manifest), binding));
  traced++;
}
if (traced === 0) throw new Error('No route traces the staging lock package.');
console.log(`Verified native staging locks and ${traced} route traces.`);
