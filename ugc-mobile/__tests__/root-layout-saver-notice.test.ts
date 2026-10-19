import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Source assertions, as `root-layout-notifications-received.test.ts` makes
 * them: the root layout cannot be mounted without the whole native chain
 * behind it. Review finding #19: with either half missing nothing tells
 * anyone, and every save stays "Someone" (`lib/saver-notice.ts` shows nothing
 * while no bar is mounted, and nothing reads the account's memory or record
 * without the sync).
 */
const rootLayout = readFileSync(path.resolve(__dirname, '..', 'app/_layout.tsx'), 'utf8');

/** The layout without its comments, so a commented-out mount does not count. */
const code = rootLayout
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

function only(tag: string) {
  const first = code.indexOf(tag);
  expect(first, `${tag} is rendered`).toBeGreaterThan(-1);
  expect(code.indexOf(tag, first + tag.length), `${tag} is rendered once`).toBe(-1);
  return first;
}

function inside(position: number, open: string, close: string) {
  const start = code.indexOf(open);
  const end = code.indexOf(close, start);
  expect(start, `${open} is in the layout`).toBeGreaterThan(-1);
  expect(end, `${close} is in the layout`).toBeGreaterThan(start);
  return position > start && position < end;
}

describe('the saver notice in the root layout', () => {
  it('imports both halves from the bar module', () => {
    const imported = code.match(/import \{([^}]*)\} from '@\/components\/saver-notice-bar';/);
    expect(imported).not.toBeNull();
    expect(imported![1].split(',').map((name) => name.trim()).filter(Boolean).sort()).toEqual(['SaverNoticeBar', 'SaverNoticeSync']);
  });

  it('mounts the sync once, inside the auth and query providers it reads', () => {
    const sync = only('<SaverNoticeSync />');
    expect(inside(sync, '<AuthProvider>', '</AuthProvider>')).toBe(true);
    expect(inside(sync, '<QueryClientProvider', '</QueryClientProvider>')).toBe(true);
  });

  it('mounts the bar once, after every screen so it is drawn above them, inside the safe area it is placed by', () => {
    const bar = only('<SaverNoticeBar />');
    expect(bar).toBeGreaterThan(code.indexOf('</Stack>'));
    expect(bar).toBeGreaterThan(code.indexOf('</OverlayHost>'));
    expect(inside(bar, '<SafeAreaProvider>', '</SafeAreaProvider>')).toBe(true);
  });
});
