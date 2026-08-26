import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '..');
const sourceRoots = ['app', 'components'] as const;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...sourceFiles(absolutePath));
    } else if (/\.tsx?$/.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

const files = sourceRoots.flatMap((root) => sourceFiles(path.join(mobileRoot, root)));

/**
 * Ways the balance legitimately appears without being rendered: handed to a
 * child, destructured, compared, or stored.
 */
const NOT_RENDERED = [
  /\b\w*[Cc]redits=\{[^}]*\}/,           // credits={credits} — a child renders it
  /\{\s*[^}]*\bcredits\b[^}]*\}\s*=/,    // const { credits } = ...
  /\bcredits\s*[:,]/,                     // object literal, type member, arg list
  /\bupdateCredits\b|\buseCredits\b/,     // helpers that take, not show, a balance
];

/**
 * Strip quoted text so only real identifiers are left to match.
 *
 * Copy legitimately talks about credits — "Manage profile details, credits, and
 * app preferences" — and matching the bare word flagged a dozen such sentences.
 */
function withoutStringLiterals(line: string) {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // Inside a template, keep the `${…}` holes and drop the literal text.
    .replace(/`(?:[^`\\]|\\.)*`/g, (template) => (template.match(/\$\{[^}]*\}/g) ?? []).join(' '));
}

/**
 * A balance being turned into text.
 *
 * Earlier versions matched one spelling at a time and three call sites slipped
 * past in turn — `{credits}`, then `${credits ?? 0}`, then
 * `String(credits ?? profile?.credits ?? 0)`. Matching the shape rather than
 * the spelling is what closes it.
 */
const RENDERS_BALANCE = /\{[^}]*\bcredits\b[^}]*\}/;

/**
 * Balances run to five figures. Rendered raw they read as a meaningless run of
 * digits ("26863"), and the app formatted them in some places but not others —
 * the header, the side menu and the creation bar each showed a different style
 * of the same number.
 */
describe('credit balance formatting coverage', () => {
  it('renders every balance through the shared formatter', () => {
    const raw = files
      .map((filePath) => ({ filePath, source: readFileSync(filePath, 'utf8') }))
      .flatMap(({ filePath, source }) => source
        .split('\n')
        .map((line, index) => ({ filePath, line: withoutStringLiterals(line), number: index + 1 }))
        .filter(({ line }) => RENDERS_BALANCE.test(line))
        .filter(({ line }) => !NOT_RENDERED.some((pattern) => pattern.test(line)))
        .filter(({ line }) => !line.includes('formatCreditAmount')))
      .map(({ filePath, number }) => `${path.relative(mobileRoot, filePath).replaceAll(path.sep, '/')}:${number}`);

    expect(raw).toEqual([]);
  });

  it('keeps the locale decision in one place', () => {
    const inlineLocale = files
      .map((filePath) => ({ filePath, source: readFileSync(filePath, 'utf8') }))
      .filter(({ source }) => source.includes("toLocaleString('en-IN')"))
      .map(({ filePath }) => path.relative(mobileRoot, filePath).replaceAll(path.sep, '/'));

    expect(inlineLocale).toEqual([]);
  });
});
