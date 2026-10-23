import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_INLINED_COPIES,
  countInlinedCopies,
  stylesheetNeedles,
  verifyInlineCssCopies,
} from '../../scripts/build/check-inline-css-copies.mjs';

// A sheet like the root one: rules with quotes, child combinators and an ampersand, which the
// payload writes escaped.
const css = Array.from({ length: 60 }, (_, i) => (
  `.rule-${i}>.child{content:"${i}";margin:${i % 7}px ${i % 5}rem;color:#${(i * 4099).toString(16).padStart(6, '0')}}`
  + `.wide-${i}{grid-template-columns:minmax(0,1fr) repeat(${i % 4 + 1},minmax(12rem,1fr));transition:opacity 160ms ease}`
)).join('') + '.amp[data-x="a&b"]{display:none}';

// Next's flight rows: a text row holding the sheet, pushed as a JSON string inside a <script>, with
// `<`, `>` and `&` written as unicode escapes.
function flightCopy(text: string) {
  const row = JSON.stringify(`2:T${text.length.toString(16)},${text}`)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<script>self.__next_f.push([1,${row}])</script>`;
}

function document(flightCopies: number, { style = true } = {}) {
  return '<!DOCTYPE html><html><head>'
    + (style ? `<style data-precedence="next" data-href="/_next/static/chunks/root.css">${css}</style>` : '')
    + '</head><body><main>Page</main>'
    + Array.from({ length: flightCopies }, () => flightCopy(css)).join('')
    + '</body></html>';
}

let root: string | null = null;

async function nextDirectory(documents: Record<string, string>, sheets: Record<string, string> = { 'root.css': css }) {
  root = await mkdtemp(path.join(tmpdir(), 'magicbooklet-inline-css-'));
  await mkdir(path.join(root, 'static', 'chunks'), { recursive: true });
  for (const [name, text] of Object.entries(sheets)) await writeFile(path.join(root, 'static', 'chunks', name), text);
  for (const [name, html] of Object.entries(documents)) {
    await mkdir(path.dirname(path.join(root, 'server', 'app', name)), { recursive: true });
    await writeFile(path.join(root, 'server', 'app', name), html);
  }
  return root;
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('the inlined stylesheet copies check (build:verify)', () => {
  it('counts a sheet in its <style> tag and in the escaped payload alike', () => {
    const needles = stylesheetNeedles(css);
    expect(needles.length).toBeGreaterThanOrEqual(2);
    expect(countInlinedCopies(document(1), needles)).toBe(2);
    expect(countInlinedCopies(document(2), needles)).toBe(3);
    expect(countInlinedCopies(document(1, { style: false }), needles)).toBe(1);
    expect(countInlinedCopies('<html></html>', needles)).toBe(0);
  });

  it('passes documents that carry the sheet twice', async () => {
    const directory = await nextDirectory({ 'index.html': document(1), 'terms.html': document(1), 'templates/new.html': document(1, { style: false }) });
    await expect(verifyInlineCssCopies({ nextDirectory: directory })).resolves.toMatchObject({
      documents: 3,
      carrying: 3,
      most: MAX_INLINED_COPIES,
    });
  });

  it('fails a document that carries it a third time, the global-error boundary\'s copy', async () => {
    const directory = await nextDirectory({ 'index.html': document(1), 'terms.html': document(2) });
    await expect(verifyInlineCssCopies({ nextDirectory: directory })).rejects.toThrow(/terms\.html: static\/chunks\/root\.css 3 times[\s\S]*98110/);
  });

  it('fails when no document carries any sheet, as it could then see nothing', async () => {
    const directory = await nextDirectory({ 'index.html': '<!DOCTYPE html><html><body>Page</body></html>' });
    await expect(verifyInlineCssCopies({ nextDirectory: directory })).rejects.toThrow(/None of 1 prerendered/);
  });

  it('leaves out a sheet too small to name by its text', () => {
    expect(stylesheetNeedles('.a{color:red}')).toEqual([]);
    expect(countInlinedCopies(document(5), [])).toBe(0);
  });
});
