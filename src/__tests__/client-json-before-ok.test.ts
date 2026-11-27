import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The platform answers a timed-out or crashed function with an HTML 502 or 504. A client that read
 * `await response.json()` before checking `response.ok`, or inside its `!response.ok` branch, threw
 * "Unexpected token '<'…" and showed those words to the person in place of its own message, an
 * unlock paid with credits included (audit 2026-11-27, finding 9). Such a read goes through
 * `readJsonResponse` (`src/lib/read-json-response.ts`), which never throws. A read after the
 * `!response.ok` branch has returned or thrown is left alone: its success path is unchanged.
 */

const ROOTS = ['src/app', 'src/components'].map((root) => path.join(process.cwd(), root));
const API_ROOT = path.join(process.cwd(), 'src/app/api');
const JSON_READ = /await\s+([A-Za-z_$][\w$.]*)\.json\(\)(?!\s*\.catch)/g;

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    if (file === API_ROOT) return [];
    if (statSync(file).isDirectory()) return walk(file);
    return /\.(?:ts|tsx)$/.test(name) ? [file] : [];
  });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Each `await x.json()` read before `x.ok` is checked, or inside `if (!x.ok)`, outside a try. */
function findUnguardedReads(): string[] {
  const found: string[] = [];
  for (const file of ROOTS.flatMap(walk)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const match of line.matchAll(JSON_READ)) {
        const ok = new RegExp(`${escape(match[1])}\\.ok\\b`);
        const before = lines.slice(Math.max(0, index - 8), index).join('\n');
        const after = lines.slice(index + 1, index + 11).join('\n');
        // A read wrapped in its own try (a helper that answers null) cannot throw at its caller.
        const inOwnTry = /\btry\s*\{\s*$/.test(lines[index - 1] ?? '');
        const readFirst = ok.test(after) && !ok.test(before);
        const insideFailure = new RegExp(`if\\s*\\(\\s*!\\s*${escape(match[1])}\\.ok\\s*\\)\\s*\\{\\s*$`)
          .test(lines[index - 1] ?? '');
        if (!inOwnTry && (readFirst || insideFailure)) found.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
      }
    });
  }
  return found;
}

describe('client reads of an API answer', () => {
  it('never parse a body as JSON before checking response.ok (use readJsonResponse)', () => {
    expect(findUnguardedReads()).toEqual([]);
  });
});
