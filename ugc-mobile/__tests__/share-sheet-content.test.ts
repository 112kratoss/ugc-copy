import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { shareLinkContent, shareMessageContent } from '../lib/share-sheet-content';

const link = 'https://magicbooklet.com/showcase/post-1?s=showcase-reel&r=30b5f916c7aa';
const timesTheLinkAppears = (values: Array<string | undefined>) => values.join('\n').split(link).length - 1;

/**
 * React Native gives iOS's share sheet `message` and `url` as two separate
 * items, and every destination receives both; Android sends `message` alone.
 * The app put the link in both, so on an iPhone it went out twice (Copy pasted
 * "minnal2.0⏎<link> <link>", owner's report, 2026-11-14). With the words alone
 * in `message`, Copy put them first and the link second, and the pasteboard's
 * text (`UIPasteboard.string`) was "minnal2.0" with no link (review of #801,
 * checked on the simulator). One item each time is what every reader gets.
 */
describe("a page's share", () => {
  it('gives iOS the link alone, one item every reader gets', () => {
    const content = shareLinkContent({ title: 'minnal2.0', url: link }, 'ios');

    expect(content).toEqual({ url: link });
    expect(timesTheLinkAppears([content.message, content.url])).toBe(1);
  });

  it('puts the name and the link in the message on Android, which sends nothing else', () => {
    const content = shareLinkContent({ title: 'minnal2.0', url: link }, 'android');

    expect(content).toEqual({ title: 'minnal2.0', message: `minnal2.0\n${link}` });
    expect(timesTheLinkAppears([content.message])).toBe(1);
  });

  it('writes its own line above the link on Android when one is given', () => {
    expect(shareLinkContent({ title: 'Nova', text: 'Nova on Magicbooklet', url: link }, 'android'))
      .toEqual({ title: 'Nova', message: `Nova on Magicbooklet\n${link}` });
    expect(shareLinkContent({ title: 'Nova', text: 'Nova on Magicbooklet', url: link }, 'ios')).toEqual({ url: link });
  });

  it('sends the link alone on Android when the page has no name', () => {
    expect(shareLinkContent({ title: '  ', url: link }, 'android')).toEqual({ title: '  ', message: link });
    expect(shareLinkContent({ title: '', url: link }, 'android')).toEqual({ message: link });
  });
});

describe("a message's share", () => {
  it('sends the words whole with the link once, and no url item that would repeat it', () => {
    const content = shareMessageContent({ title: 'Invite & Earn', text: 'Try Magicbooklet. Referral link.', url: link });

    expect(content).toEqual({ title: 'Invite & Earn', message: `Try Magicbooklet. Referral link.\n${link}` });
    expect(timesTheLinkAppears([content.message, content.url])).toBe(1);
  });
});

describe('every share sheet the app opens', () => {
  // Nine call sites each built their own content, which is how all nine came
  // to send the link twice on iOS. Any new one goes through the same rules.
  const root = join(__dirname, '..');
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  const sources = ['app', 'components', 'lib'].flatMap((dir) =>
    sourceFiles(join(root, dir)).map((file) => ({ file: relative(root, file), text: readFileSync(file, 'utf8') }))
  );
  const calls = sources.flatMap(({ file, text }) =>
    [...text.matchAll(/\bShare\.share\(\s*([^\s(]*)/g)].map((match) => ({ file, argument: match[1] }))
  );

  it('is given its content by shareLinkContent or shareMessageContent', () => {
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((call) => !['shareLinkContent', 'shareMessageContent'].includes(call.argument))).toEqual([]);
  });

  it('reaches the share sheet only through Share.share', () => {
    // A renamed import, a destructured `share` or the action sheet's own share
    // method would get past the scan above.
    const bypasses = sources.filter(({ text }) =>
      /\bShare\s+as\s+\w+/.test(text) ||
      /\{\s*share\b[^}]*\}\s*=\s*Share\b/.test(text) ||
      /showShareActionSheetWithOptions/.test(text)
    );
    expect(bypasses.map(({ file }) => file)).toEqual([]);
  });
});
