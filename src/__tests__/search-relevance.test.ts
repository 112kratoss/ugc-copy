import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  blendSearchLists,
  judgeSearchRelevance,
  ndcgAt,
  parseSearchBlendConstants,
  recordedSearchRuns,
  scoreSearchOrder,
  searchRelevanceGrades,
  searchRelevancePostId,
  searchRelevanceQueryWordCount,
  type RecordedSearchRun,
  type SearchBlendConstants,
  type SearchRelevanceQuery,
  type SearchRelevanceSet,
} from '@/lib/search-relevance';

import { searchBlendApplies } from '../../ugc-mobile/lib/public-search-policy/search-blend';

// The part of the relevance check that runs where there is no embedding
// model. `npm run search:relevance` reads both orders from a database with
// real gte-small vectors and writes what it read to
// config/search-relevance/recorded-run.json; this file holds that recording
// to the set, to the constants of the newest search_blended_posts, to the
// second copy of the blend, and to the verdict. A ranking change that moves a
// constant fails here until the check is run again and re-recorded
// (docs/search-ranking-operations.md).

const root = process.cwd();
const set = JSON.parse(readFileSync(join(root, 'config/search-relevance/relevance-set.json'), 'utf8')) as SearchRelevanceSet;
const recorded = JSON.parse(readFileSync(join(root, 'config/search-relevance/recorded-run.json'), 'utf8')) as RecordedSearchRun;

const migrationsDirectory = join(root, 'supabase/migrations');
function newestBlendDefinition(): string {
  const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.search_blended_posts\s*\(/i;
  const definers = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => pattern.test(readFileSync(join(migrationsDirectory, name), 'utf8').replace(/--.*$/gm, '')));
  expect(definers.length).toBeGreaterThan(0);
  return readFileSync(join(migrationsDirectory, definers[definers.length - 1]), 'utf8').replace(/--.*$/gm, '');
}

const postKeys = new Set(set.posts.map((post) => post.key));
const idOfKey = new Map(set.posts.map((post, index) => [post.key, searchRelevancePostId(index)]));
const tieBreak = (key: string) => idOfKey.get(key) ?? key;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

describe('the relevance set', () => {
  it('is large enough to mean something: at least 80 posts and 40 queries', () => {
    expect(set.version).toBe(1);
    expect(set.posts.length).toBeGreaterThanOrEqual(80);
    expect(set.queries.length).toBeGreaterThanOrEqual(40);
    expect(new Set(set.posts.map((post) => post.creator)).size).toBeGreaterThanOrEqual(3);
  });

  it('names every post once, by a creator and a made-with it defines', () => {
    expect(postKeys.size).toBe(set.posts.length);
    for (const post of set.posts) {
      expect(set.creators, post.key).toContain(post.creator);
      expect(Object.keys(set.made), post.key).toContain(post.made);
      expect(post.title.trim(), post.key).not.toBe('');
      expect(['image', 'video'], post.key).toContain(post.kind);
    }
  });

  it('judges each query against posts that exist, each at one grade', () => {
    expect(new Set(set.queries.map((query) => query.id)).size).toBe(set.queries.length);
    for (const query of set.queries) {
      const listed = (['3', '2', '1'] as const).flatMap((grade) => query.relevant[grade] ?? []);
      expect(new Set(listed).size, `${query.id}: a post at two grades`).toBe(listed.length);
      for (const key of listed) expect(postKeys.has(key), `${query.id}: ${key}`).toBe(true);
      expect(searchRelevanceGrades(query).size).toBe(listed.length);
    }
  });

  it('marks as a title query only one whose words are a post\'s title, and grades that post highest', () => {
    const exact = set.queries.filter((query) => query.exactTitle);
    expect(exact.length).toBeGreaterThanOrEqual(10);
    for (const query of exact) {
      const post = set.posts.find((entry) => entry.key === query.exactTitle);
      expect(post?.title.toLowerCase(), query.id).toBe(query.text.toLowerCase());
      expect(query.relevant['3'], query.id).toContain(query.exactTitle);
      // Such a query is one the service blends: the rule is tested where it could bite.
      expect(searchRelevanceQueryWordCount(query.text), query.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('holds every kind of query the blend can help or hurt', () => {
    const kinds = new Map<string, number>();
    for (const query of set.queries) kinds.set(query.kind, (kinds.get(query.kind) ?? 0) + 1);
    for (const kind of ['exact', 'model', 'paraphrase', 'mixed', 'noisy', 'trap', 'off', 'one-word']) {
      expect(kinds.get(kind) ?? 0, kind).toBeGreaterThanOrEqual(2);
    }
    // Queries about nothing judge no post relevant; every other query judges some.
    for (const query of set.queries) {
      expect(searchRelevanceGrades(query).size === 0, query.id).toBe(query.kind === 'off');
    }
    // Near-misses and posts whose title says nothing of their subject.
    expect(set.posts.filter((post) => post.key.startsWith('mis-')).length).toBeGreaterThanOrEqual(10);
    expect(set.posts.filter((post) => /^(Version|Take|Test|Sketch|Option|Attempt|Frame|Look|Shot|WIP|Round)\b/.test(post.title)).length)
      .toBeGreaterThanOrEqual(8);
  });

  it('counts a query\'s words as the clients\' rule does', () => {
    for (const query of set.queries) {
      expect(searchRelevanceQueryWordCount(query.text) >= 2, query.id)
        .toBe(searchBlendApplies({ query: query.text, type: 'posts', sort: 'top', exact: false, settled: true }));
    }
  });
});

describe('scoring an order', () => {
  const query: SearchRelevanceQuery = { id: 'q', text: 'two words', kind: 'mixed', relevant: { 3: ['a'], 2: ['b'], 1: ['c'] } };
  const grades = searchRelevanceGrades(query);

  it('gives the best order an nDCG of 1 and discounts a relevant post by its place', () => {
    expect(ndcgAt(['a', 'b', 'c'], grades)).toBe(1);
    expect(ndcgAt([], grades)).toBe(0);
    // gains 7, 3, 1 over log2 of the place plus one
    const ideal = 7 + 3 / Math.log2(3) + 1 / Math.log2(4);
    expect(ndcgAt(['x', 'a'], grades)).toBeCloseTo((7 / Math.log2(3)) / ideal, 12);
    expect(ndcgAt(['c', 'b', 'a'], grades)).toBeCloseTo((1 + 3 / Math.log2(3) + 7 / Math.log2(4)) / ideal, 12);
    // Only the first ten places count.
    expect(ndcgAt([...Array.from({ length: 10 }, (_, index) => `x${index}`), 'a'], grades)).toBe(0);
  });

  it('has no nDCG for a query with nothing relevant, and counts what such a query is given', () => {
    expect(ndcgAt(['a'], new Map())).toBeNull();
    const off: SearchRelevanceQuery = { id: 'o', text: 'about nothing', kind: 'off', relevant: {} };
    expect(scoreSearchOrder(off, ['a', 'b'])).toEqual({ ndcg: null, topHit: null, relevantInTop: 0, wrongInDepth: 2 });
  });

  it('calls a post of grade 2 or 3 among the first five a hit, and a post near the subject not one', () => {
    expect(scoreSearchOrder(query, ['x', 'y', 'z', 'w', 'b']).topHit).toBe(true);
    expect(scoreSearchOrder(query, ['x', 'y', 'z', 'w', 'v', 'b']).topHit).toBe(false);
    expect(scoreSearchOrder(query, ['c']).topHit).toBe(false);
    expect(scoreSearchOrder(query, ['c', 'x', 'a']).relevantInTop).toBe(2);
    expect(scoreSearchOrder(query, ['c', 'x', 'a']).wrongInDepth).toBe(1);
  });
});

describe('the verdict', () => {
  const small: SearchRelevanceSet = {
    version: 1, about: '', creators: ['c1'], made: { m: { tool: 'T' } },
    posts: ['a', 'b', 'c', 'd'].map((key) => ({ key, creator: 'c1', title: key, made: 'm', kind: 'image' as const, ageDays: 0 })),
    queries: [
      { id: 'q1', text: 'title words', kind: 'exact', exactTitle: 'a', relevant: { 3: ['a'], 2: ['b'] } },
      { id: 'q2', text: 'about nothing', kind: 'off', relevant: {} },
      { id: 'q3', text: 'single', kind: 'one-word', relevant: { 2: ['c'] } },
    ],
  };
  const runs = (overrides: Record<string, { words?: string[]; blended?: string[] }> = {}) => small.queries.map((query) => ({
    id: query.id,
    words: overrides[query.id]?.words ?? (query.id === 'q1' ? ['a'] : query.id === 'q3' ? ['c'] : []),
    blended: overrides[query.id]?.blended ?? (query.id === 'q1' ? ['a', 'b'] : query.id === 'q3' ? ['c'] : []),
  }));

  it('passes a blend that adds a relevant post behind the title match', () => {
    const verdict = judgeSearchRelevance(small, runs());
    expect(verdict.failures).toEqual([]);
    expect(verdict.judged).toBe(2);
    expect(verdict.blended.ndcg).toBeGreaterThan(verdict.words.ndcg);
    expect(verdict.worse).toEqual([]);
  });

  it('fails when the post with the query\'s title loses first place', () => {
    const verdict = judgeSearchRelevance(small, runs({ q1: { blended: ['b', 'a'] } }));
    expect(verdict.failures).toEqual(expect.arrayContaining([expect.stringContaining('lost first place to b')]));
  });

  it('fails when the blend is worse overall', () => {
    const verdict = judgeSearchRelevance(small, runs({ q1: { words: ['a', 'b'], blended: ['a', 'd', 'c', 'x', 'y', 'b'] } }));
    expect(verdict.failures).toEqual(expect.arrayContaining([expect.stringContaining('mean nDCG@10 fell')]));
    expect(verdict.worse.map((entry) => entry.id)).toEqual(['q1']);
  });

  it('fails when a query about nothing is given posts the words did not find', () => {
    const verdict = judgeSearchRelevance(small, runs({ q2: { blended: ['d'] } }));
    expect(verdict.failures).toEqual(expect.arrayContaining([expect.stringContaining('queries about nothing return more posts')]));
  });

  it('fails when a one-word query is blended, or a query has no run', () => {
    expect(judgeSearchRelevance(small, runs({ q3: { blended: ['c', 'd'] } })).failures)
      .toEqual(expect.arrayContaining([expect.stringContaining('a one-word query was blended')]));
    expect(judgeSearchRelevance(small, runs().slice(0, 2)).failures)
      .toEqual(expect.arrayContaining([expect.stringContaining('q3 "single": no run')]));
  });
});

describe('the second copy of the blend', () => {
  const constants: SearchBlendConstants = {
    rrfK: 50, wordWeight: 1, meaningWeight: 0.9, wordWindow: 50, meaningWindow: 30, minSimilarity: 0.82, exactTitleScore: 30,
  };

  it('merges the worked example as the database does (search_blended_posts.test.sql)', () => {
    const blended = blendSearchLists(
      [{ key: '11', score: 33.5 }, { key: '12', score: 23.6 }, { key: '13', score: 3.1 }, { key: '14', score: 1.2 }],
      [
        { key: '13', similarity: 0.95 }, { key: '15', similarity: 0.9 }, { key: '12', similarity: 0.83 },
        { key: '17', similarity: 0.825 }, { key: '16', similarity: 0.815 },
      ],
      constants,
    );
    expect(blended.map((row) => `${row.key}:${row.matchedBy}`)).toEqual([
      '11:words', '13:both', '12:both', '14:words', '15:meaning', '17:meaning',
    ]);
  });

  it('keeps posts whose title is the query first in the word order, and the rest of the word order after the window', () => {
    const words = Array.from({ length: 4 }, (_, index) => ({ key: `w${index + 1}`, score: index < 2 ? 31 - index : 5 - index }));
    const blended = blendSearchLists(words, [{ key: 'w4', similarity: 0.99 }, { key: 'w2', similarity: 0.98 }], { ...constants, wordWindow: 3 });
    // w1 and w2 are title matches; w4 is past the window of three: it keeps its
    // place in the word order, once, however near it is in meaning.
    expect(blended.map((row) => `${row.key}:${row.matchedBy}`)).toEqual(['w1:words', 'w2:both', 'w3:words', 'w4:words']);
  });

  it('lets the nearest meaning-only post in after the sixth word row', () => {
    const words = Array.from({ length: 10 }, (_, index) => ({ key: `w${index + 1}`, score: 9 - index * 0.1 }));
    const blended = blendSearchLists(words, [{ key: 'm1', similarity: 0.9 }, { key: 'm2', similarity: 0.89 }], constants);
    expect(blended.map((row) => row.key)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'm1', 'w7', 'm2', 'w8', 'w9', 'w10']);
  });

  it('breaks a tie by the word rank, then by the id the database would', () => {
    const blended = blendSearchLists([], [{ key: 'b', similarity: 0.9 }, { key: 'a', similarity: 0.9 }], constants);
    expect(blended.map((row) => row.key)).toEqual(['b', 'a']);
  });
});

describe('the recorded run', () => {
  it('was recorded with the constants the newest search_blended_posts declares', () => {
    expect(recorded.version).toBe(1);
    expect(recorded.embeddingModel).toBe('gte-small');
    expect(
      recorded.constants,
      'search_blended_posts changed since the relevance check was recorded: run `npm run search:relevance -- --record` on a local stack (docs/search-ranking-operations.md)',
    ).toEqual(parseSearchBlendConstants(newestBlendDefinition()));
  });

  it('covers every query of the set, with posts of the set', () => {
    expect(recorded.queries.map((query) => query.id)).toEqual(set.queries.map((query) => query.id));
    for (const query of recorded.queries) {
      for (const [key] of [...query.words, ...query.meaning, ...query.blended]) expect(postKeys.has(key), `${query.id}: ${key}`).toBe(true);
      expect(new Set(query.blended.map(([key]) => key)).size, `${query.id}: a post twice`).toBe(query.blended.length);
    }
  });

  it('holds, for every query, the order the second copy of the blend makes of the same lists', () => {
    for (const query of recorded.queries) {
      const text = set.queries.find((entry) => entry.id === query.id)?.text ?? '';
      const expected = searchRelevanceQueryWordCount(text) < 2
        ? query.words.map(([key]) => `${key}:words`)
        : blendSearchLists(
          query.words.map(([key, score]) => ({ key, score })),
          query.meaning.map(([key, similarity]) => ({ key, similarity })),
          recorded.constants,
          tieBreak,
        ).map((row) => `${row.key}:${row.matchedBy}`);
      expect(query.blended.map(([key, by]) => `${key}:${by}`), `${query.id} "${text}"`).toEqual(expected);
    }
  });

  it('never calls a post a meaning match that the word order also returned', () => {
    for (const query of recorded.queries) {
      const words = new Set(query.words.map(([key]) => key));
      for (const [key, by] of query.blended) {
        if (by === 'meaning') expect(words.has(key), `${query.id}: ${key}`).toBe(false);
        else expect(words.has(key), `${query.id}: ${key}`).toBe(true);
      }
    }
  });

  it('passes the check: no worse than the word order, every title match first, nothing for queries about nothing', () => {
    const verdict = judgeSearchRelevance(set, recordedSearchRuns(recorded));
    expect(verdict.failures).toEqual([]);
    expect(verdict.queries).toBe(set.queries.length);
    // The numbers of the recording (2026-11-17, real gte-small vectors: whole words first,
    // 20261116200234, on the set with "cat", "car" and their traps). A re-recording changes them
    // here, in the same change that changed the ranking. "studio light" is listed because its word
    // order got better than its blend (0.3358 to 0.5293 by words, 0.4316 to 0.4887 blended): no
    // query of either order scored lower than in the recording before (docs/search-ranking-operations.md).
    expect({
      judged: verdict.judged,
      words: {
        ndcg: round4(verdict.words.ndcg), topHitRate: round4(verdict.words.topHitRate),
        relevantInTop: round4(verdict.words.relevantInTop), wrongInDepth: round4(verdict.words.wrongInDepth),
        offCorpusPosts: verdict.words.offCorpusPosts,
      },
      blended: {
        ndcg: round4(verdict.blended.ndcg), topHitRate: round4(verdict.blended.topHitRate),
        relevantInTop: round4(verdict.blended.relevantInTop), wrongInDepth: round4(verdict.blended.wrongInDepth),
        offCorpusPosts: verdict.blended.offCorpusPosts,
      },
      worse: verdict.worse.map((entry) => entry.id),
    }).toEqual({
      judged: 72,
      words: { ndcg: 0.5449, topHitRate: 0.75, relevantInTop: 1.2778, wrongInDepth: 0.4306, offCorpusPosts: 0 },
      blended: { ndcg: 0.7793, topHitRate: 0.9722, relevantInTop: 2.1806, wrongInDepth: 2, offCorpusPosts: 0 },
      worse: ['q55'],
    });
  });

  it('puts the posts that hold a one-word query whole before those that hold it only inside longer words (20261116200234)', () => {
    // The defect of 2026-11-17: "cat" put posts about no cat among its first four. Here
    // "Category winners", "Catching the bus", "Gothic cathedral" and two captions that say
    // "delicate", "intricate" or "scattered" hold its letters, not the word; for "car" a caption
    // says "cargo", a title "supercar", others "skincare", "headscarf" and "scarlet".
    const wordsOf = (id: string) => recorded.queries.find((entry) => entry.id === id)?.words ?? [];
    const cat = wordsOf('q76');
    expect(cat.map(([key]) => key)).toEqual(['fas-07', 'pet-03', 'ani-05', 'mis-11', 'pet-08', 'trp-03', 'trp-04', 'arc-09', 'trp-01', 'trp-02']);
    // Every whole match scores 0 or more, every partial one under 0.
    expect(cat.slice(0, 5).every(([, score]) => score >= 0)).toBe(true);
    expect(cat.slice(5).every(([, score]) => score < 0)).toBe(true);
    const car = wordsOf('q77');
    expect(car.slice(0, 2).map(([key]) => key)).toEqual(['car-03', 'car-05']);
    expect(car.slice(2).every(([, score]) => score < 0)).toBe(true);
  });

  it('keeps first place for every title match, each of them found by both lists or pinned', () => {
    for (const query of set.queries.filter((entry) => entry.exactTitle)) {
      const run = recorded.queries.find((entry) => entry.id === query.id);
      expect(run?.words[0]?.[0], query.id).toBe(query.exactTitle);
      expect(run?.words[0]?.[1], query.id).toBeGreaterThanOrEqual(recorded.constants.exactTitleScore);
      expect(run?.blended[0]?.[0], query.id).toBe(query.exactTitle);
    }
  });
});
