import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(process.cwd(), 'src');
const testsRoot = path.join(sourceRoot, '__tests__');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    if (absolutePath === testsRoot) continue;
    if (fs.statSync(absolutePath).isDirectory()) {
      files.push(...sourceFiles(absolutePath));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

/** Lines where `instanceof HTMLElement` is followed, within a few lines, by `.closest(`. */
function narrowingsBeforeClosest(source: string): number[] {
  return [...source.matchAll(/instanceof HTMLElement/g)]
    .filter((match) => source.slice(match.index, match.index + 200).includes('.closest('))
    .map((match) => source.slice(0, match.index).split('\n').length);
}

describe('event target narrowing', () => {
  it('never narrows a target to HTMLElement before asking closest()', () => {
    // Most clicks and wheels over a control land on its icon: an <svg> or a
    // <path>, which are Elements but not HTMLElements. Narrowed with
    // `instanceof HTMLElement`, such a target read as outside every control:
    // a click on the feed card's heart saved the post and opened it too, and a
    // wheel over an icon in the reel's details turned to the next post.
    // `instanceof Element` is what `closest()` needs.
    const offenders: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      for (const line of narrowingsBeforeClosest(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(process.cwd(), file).replaceAll(path.sep, '/')}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('finds the narrowing it guards against, and not a focus restore', () => {
    expect(narrowingsBeforeClosest([
      'const target = event.target instanceof HTMLElement ? event.target : null;',
      "if (target?.closest('[data-reel-scroll-region=\"details\"]')) return;",
    ].join('\n'))).toEqual([1]);
    expect(narrowingsBeforeClosest(
      'previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;'
    )).toEqual([]);
  });
});
