import { resolveRobots } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data';
import type { MetadataRoute } from 'next';
import { describe, expect, it } from 'vitest';

import robots from '@/app/robots';

type RobotsRule = Extract<MetadataRoute.Robots['rules'], unknown[]>[number];

function list(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : [value].flat();
}

function rulesOf(file: MetadataRoute.Robots): RobotsRule[] {
  return [file.rules].flat();
}

/**
 * Whether `crawler` may fetch `url` under RFC 9309: a crawler obeys the groups
 * naming it and, only when none does, the `*` group; within them the longest
 * matching path wins, and Allow wins a tie. The file uses neither `*` nor `$`
 * inside a path (asserted below), so a match is a prefix match.
 */
function mayCrawl(file: MetadataRoute.Robots, crawler: string, url: string): boolean {
  const agentsOf = (rule: RobotsRule) => list(rule.userAgent ?? '*').map((agent) => agent.toLowerCase());
  const named = rulesOf(file).filter((rule) => agentsOf(rule).includes(crawler.toLowerCase()));
  const groups = named.length > 0 ? named : rulesOf(file).filter((rule) => agentsOf(rule).includes('*'));
  let best = { length: -1, allow: true };
  for (const rule of groups) {
    for (const [allow, paths] of [[true, list(rule.allow)], [false, list(rule.disallow)]] as const) {
      for (const path of paths) {
        if (url.startsWith(path) && (path.length > best.length || (path.length === best.length && allow))) {
          best = { length: path.length, allow };
        }
      }
    }
  }
  return best.allow;
}

const SEARCH_AND_ASSISTANTS = ['Googlebot', 'Bingbot', 'Applebot', 'facebookexternalhit', 'ClaudeBot', 'GPTBot'];
const SEO_TOOLS = ['SemrushBot', 'AhrefsBot', 'PetalBot', 'MJ12bot', 'DotBot', 'Baiduspider'];

describe('robots.txt', () => {
  const file = robots();

  it('uses only prefixes, which is all the evaluator above reads', () => {
    for (const rule of rulesOf(file)) {
      for (const path of [...list(rule.allow), ...list(rule.disallow)]) {
        expect(path).toMatch(/^\/[^*$]*$/);
      }
    }
  });

  it('keeps crawlers off the filtered marketplace lists, and on the marketplace and its recipes', () => {
    // Each filter, sort or search renders a function on request; crawlers
    // walked about 3,700 of them a week, the back links on every card included.
    for (const crawler of SEARCH_AND_ASSISTANTS) {
      expect(mayCrawl(file, crawler, '/marketplace')).toBe(true);
      expect(mayCrawl(file, crawler, '/marketplace?sort=newest')).toBe(false);
      expect(mayCrawl(file, crawler, '/marketplace?access=paid&tool=kling&sort=popular')).toBe(false);
      expect(mayCrawl(file, crawler, '/marketplace/recipe-1')).toBe(true);
      expect(mayCrawl(file, crawler, '/marketplace/sell')).toBe(true);
    }
  });

  it('keeps crawlers off search, which renders on request and is noindex', () => {
    expect(mayCrawl(file, 'Googlebot', '/search')).toBe(false);
    expect(mayCrawl(file, 'Googlebot', '/search?q=cats&type=posts')).toBe(false);
  });

  it('leaves the public pages to search engines, link previews and AI assistants', () => {
    for (const crawler of SEARCH_AND_ASSISTANTS) {
      for (const url of ['/', '/showcase', '/showcase/post-1', '/creators/someone', '/models', '/blog/a-post', '/pricing', '/templates']) {
        expect(mayCrawl(file, crawler, url)).toBe(true);
      }
    }
  });

  it('keeps the private and internal routes closed as before', () => {
    for (const url of ['/api/showcase/feed', '/auth/callback', '/create', '/create-image', '/create-video', '/create-motion', '/create-workflow', '/creations', '/home', '/login']) {
      expect(mayCrawl(file, 'Googlebot', url)).toBe(false);
    }
  });

  it('turns away the SEO tools and the search engines that send nobody, everywhere', () => {
    for (const crawler of SEO_TOOLS) {
      for (const url of ['/', '/marketplace', '/showcase/post-1', '/robots.txt']) {
        expect(mayCrawl(file, crawler, url)).toBe(false);
      }
    }
    // A crawler's own group replaces `*` for it: no other group names any of the six.
    expect(rulesOf(file).filter((rule) => list(rule.userAgent).some((agent) => SEO_TOOLS.includes(agent)))).toHaveLength(1);
  });

  it('is written out as two groups, the sitemap and the host', () => {
    const text = resolveRobots(file);

    expect(text).toContain('User-Agent: *\nAllow: /\nDisallow: /api/\n');
    expect(text).toContain('Disallow: /marketplace?\nDisallow: /search\n');
    expect(text).toContain(`${SEO_TOOLS.map((crawler) => `User-Agent: ${crawler}`).join('\n')}\nDisallow: /\n`);
    expect(text).not.toMatch(/^Disallow: \/marketplace$/m);
    expect(text).toMatch(/^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);
    expect(text).toMatch(/^Host: https?:\/\/\S+$/m);
  });
});
