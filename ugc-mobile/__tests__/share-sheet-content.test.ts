import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { shareSheetContent } from '../lib/share-sheet-content';

const link = 'https://magicbooklet.com/showcase/post-1?s=showcase-reel&r=30b5f916c7aa';
const timesTheLinkAppears = (values: Array<string | undefined>) => values.join('\n').split(link).length - 1;

/**
 * React Native gives iOS's share sheet `message` and `url` as two separate
 * items, and every destination receives both. Android sends `message` alone
 * and ignores `url`. Every share in the app used to put the link in both, so
 * on an iPhone it went out twice: Copy pasted "minnal2.0⏎<link> <link>" and
 * Reminders listed the link twice (owner's report, 2026-11-14).
 */
describe('share sheet content', () => {
  it('gives iOS the words as the message and the link once, as the url', () => {
    const content = shareSheetContent({ title: 'minnal2.0', text: 'minnal2.0', url: link }, 'ios');

    expect(content).toEqual({ title: 'minnal2.0', message: 'minnal2.0', url: link });
    expect(timesTheLinkAppears([content.message, content.url])).toBe(1);
  });

  it('puts the link in the message on Android, which sends nothing else', () => {
    const content = shareSheetContent({ title: 'minnal2.0', text: 'minnal2.0', url: link }, 'android');

    expect(content).toEqual({ title: 'minnal2.0', message: `minnal2.0\n${link}` });
    expect(timesTheLinkAppears([content.message])).toBe(1);
  });

  it('sends the link alone when no words go with it', () => {
    // An empty message would reach iOS as an empty item of its own.
    expect(shareSheetContent({ text: '  ', url: link }, 'ios')).toEqual({ url: link });
    expect(shareSheetContent({ text: '', url: link }, 'android')).toEqual({ message: link });
  });
});

describe('every share sheet the app opens', () => {
  // Nine call sites each built their own content, which is how all nine came
  // to send the link twice on iOS. Any new one goes through the same rule.
  const root = join(__dirname, '..');
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  const calls = ['app', 'components', 'lib'].flatMap((dir) =>
    sourceFiles(join(root, dir)).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\bShare\.share\(\s*([^\s(]*)/g)].map((match) => ({
        file: relative(root, file),
        argument: match[1],
      }))
    )
  );

  it('is given its content by shareSheetContent', () => {
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.argument !== 'shareSheetContent')).toEqual([]);
  });
});
