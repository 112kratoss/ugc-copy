/**
 * The relevance check of Posts search: how an order of posts is scored against
 * the fixed test set (`config/search-relevance/relevance-set.json`), and the
 * blend of the word list and the meaning list as `search_blended_posts` makes
 * it, written a second time so a recorded run can be re-scored without a
 * database.
 *
 * Pure: no database, no network, no clock. Two callers:
 *
 * - `scripts/search/relevance-check.ts` (`npm run search:relevance`), which
 *   seeds the set on a local stack, embeds it with the real model, reads both
 *   orders from the database and judges them with `judgeSearchRelevance`;
 * - `src/__tests__/search-relevance.test.ts`, which holds the recorded run
 *   (`config/search-relevance/recorded-run.json`) to the constants of the
 *   newest `search_blended_posts` and to the same verdict, in CI, where there
 *   is no embedding model.
 *
 * Runbook: `docs/search-ranking-operations.md`.
 */

export type SearchRelevanceGrade = 1 | 2 | 3;

export type SearchRelevancePost = {
  key: string;
  creator: string;
  title: string;
  caption?: string;
  prompt?: string;
  /** A key of the set's `made`: the tool, and the model where there is one. */
  made: string;
  kind: 'image' | 'video';
  ageDays: number;
};

export type SearchRelevanceQueryKind = 'exact' | 'model' | 'paraphrase' | 'mixed' | 'noisy' | 'trap' | 'off' | 'one-word';

export type SearchRelevanceQuery = {
  id: string;
  text: string;
  kind: SearchRelevanceQueryKind;
  /** The post whose title the query is: it must stay first. */
  exactTitle?: string;
  /** Post keys by grade: 3 the post asked for, 2 on the subject, 1 near it. Unlisted posts are wrong. */
  relevant: Partial<Record<'1' | '2' | '3', string[]>>;
};

export type SearchRelevanceMade = {
  tool: string;
  /** A creation's model id (a post made in the app). */
  model?: string;
  /** A Made with row's model (a post made elsewhere). */
  modelLabel?: string;
  modelSlug?: string;
};

export type SearchRelevanceSet = {
  version: 1;
  about: string;
  creators: string[];
  made: Record<string, SearchRelevanceMade>;
  posts: SearchRelevancePost[];
  queries: SearchRelevanceQuery[];
};

/**
 * The id a post of the set is seeded under: its place in `posts`, from 1. The
 * database breaks a tie of the blend by post id, so the second copy of the
 * blend breaks it by this.
 */
export function searchRelevancePostId(index: number): string {
  return `5e1e2000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
}

/** The numbers `search_blended_posts` declares, by the names it declares them under. */
export type SearchBlendConstants = {
  /** `c_rrf_k` */
  rrfK: number;
  /** `c_word_weight` */
  wordWeight: number;
  /** `c_meaning_weight` */
  meaningWeight: number;
  /** `c_word_window` */
  wordWindow: number;
  /** `c_meaning_window` */
  meaningWindow: number;
  /** `c_min_similarity` */
  minSimilarity: number;
  /** `c_exact_title_score` */
  exactTitleScore: number;
};

const BLEND_CONSTANT_NAMES: Record<keyof SearchBlendConstants, string> = {
  rrfK: 'c_rrf_k',
  wordWeight: 'c_word_weight',
  meaningWeight: 'c_meaning_weight',
  wordWindow: 'c_word_window',
  meaningWindow: 'c_meaning_window',
  minSimilarity: 'c_min_similarity',
  exactTitleScore: 'c_exact_title_score',
};

/**
 * The blend's constants as a definition of `search_blended_posts` declares
 * them (a migration's text, or `pg_get_functiondef`). Throws on one it cannot
 * read: a renamed constant must not pass as an unchanged one.
 */
export function parseSearchBlendConstants(sql: string): SearchBlendConstants {
  // The last CREATE of it: a file may also name the function in a grant or a comment.
  const creations = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.search_blended_posts\(/gi)];
  const start = creations.at(-1)?.index;
  if (start === undefined) throw new Error('No definition of public.search_blended_posts in this SQL');
  const body = sql.slice(start);
  const read = (name: string) => {
    const match = new RegExp(`\\b${name}\\s+CONSTANT\\s+(?:integer|double precision)\\s*:=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*;`).exec(body);
    if (!match) throw new Error(`search_blended_posts declares no constant ${name}`);
    return Number(match[1]);
  };
  return Object.fromEntries(
    (Object.keys(BLEND_CONSTANT_NAMES) as Array<keyof SearchBlendConstants>).map((key) => [key, read(BLEND_CONSTANT_NAMES[key])]),
  ) as SearchBlendConstants;
}

/** How many words a query has, as the blend counts them: runs of non-space characters. */
export function searchRelevanceQueryWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export type SearchMatchSource = 'words' | 'meaning' | 'both';

export type RankedWordRow = { key: string; score: number };
export type RankedMeaningRow = { key: string; similarity: number };
export type BlendedRow = { key: string; matchedBy: SearchMatchSource };

/**
 * The blended order of a word list and a meaning list, as
 * `search_blended_posts` computes it:
 *
 * - the word list is the first `wordWindow` rows of the word order;
 * - the meaning list is the nearest `meaningWindow` posts at or above
 *   `minSimilarity`;
 * - a post's blended score is the sum, over the lists that hold it, of
 *   weight / (rrfK + rank);
 * - posts whose title is the query (word score at or above
 *   `exactTitleScore`) stay first, in the word order;
 * - ties go to the better word rank, then the better meaning rank, then the
 *   post id (`tieBreak`, the database's uuid order);
 * - past the window the list is the rest of the word order, and a post there
 *   is never in the meaning list as well.
 *
 * `words` is the word order from its top, all of it (a post the caller did
 * not read cannot be known to hold the words);
 * `meaning` the nearest posts, nearest first, with their similarity, floor
 * not yet applied.
 */
export function blendSearchLists(
  words: readonly RankedWordRow[],
  meaning: readonly RankedMeaningRow[],
  constants: SearchBlendConstants,
  tieBreak: (key: string) => string = (key) => key,
): BlendedRow[] {
  const wordList = words.slice(0, constants.wordWindow);
  // A post near in meaning that holds the words past the window keeps its
  // place in the word order and is no part of the meaning list.
  const pastWindow = new Set(words.slice(constants.wordWindow).map((row) => row.key));
  const meaningList = meaning
    .filter((row) => 1 - row.similarity <= 1 - constants.minSimilarity && !pastWindow.has(row.key))
    .slice(0, constants.meaningWindow);
  const wordRank = new Map(wordList.map((row, index) => [row.key, index + 1]));
  const meaningRank = new Map(meaningList.map((row, index) => [row.key, index + 1]));
  const wordScore = new Map(wordList.map((row) => [row.key, row.score]));

  const keys = [...wordList.map((row) => row.key), ...meaningList.map((row) => row.key).filter((key) => !wordRank.has(key))];
  const placed = keys.map((key) => {
    const inWords = wordRank.get(key);
    const inMeaning = meaningRank.get(key);
    return {
      key,
      wordRank: inWords ?? Number.POSITIVE_INFINITY,
      meaningRank: inMeaning ?? Number.POSITIVE_INFINITY,
      pinned: (wordScore.get(key) ?? Number.NEGATIVE_INFINITY) >= constants.exactTitleScore,
      // The database's arithmetic, in its order: a double divided by an integer sum, twice, then added.
      fusedScore: (inWords === undefined ? 0 : constants.wordWeight / (constants.rrfK + inWords))
        + (inMeaning === undefined ? 0 : constants.meaningWeight / (constants.rrfK + inMeaning)),
      matchedBy: (inWords === undefined ? 'meaning' : inMeaning === undefined ? 'words' : 'both') as SearchMatchSource,
    };
  });
  placed.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && a.wordRank !== b.wordRank) return a.wordRank - b.wordRank;
    if (a.fusedScore !== b.fusedScore) return b.fusedScore - a.fusedScore;
    if (a.wordRank !== b.wordRank) return a.wordRank - b.wordRank;
    if (a.meaningRank !== b.meaningRank) return a.meaningRank - b.meaningRank;
    const left = tieBreak(a.key);
    const right = tieBreak(b.key);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return [
    ...placed.map(({ key, matchedBy }) => ({ key, matchedBy })),
    ...words.slice(constants.wordWindow).map((row) => ({ key: row.key, matchedBy: 'words' as const })),
  ];
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/** How deep nDCG reads an order. */
export const SEARCH_RELEVANCE_NDCG_DEPTH = 10;
/** How deep "a relevant post near the top" reads one. */
export const SEARCH_RELEVANCE_TOP_DEPTH = 5;
/** The grade a post needs to count as the relevant one near the top: on the subject, or the post asked for. */
export const SEARCH_RELEVANCE_TOP_GRADE: SearchRelevanceGrade = 2;

export function searchRelevanceGrades(query: SearchRelevanceQuery): Map<string, SearchRelevanceGrade> {
  const grades = new Map<string, SearchRelevanceGrade>();
  for (const grade of [3, 2, 1] as const) {
    for (const key of query.relevant[String(grade) as '1' | '2' | '3'] ?? []) grades.set(key, grade);
  }
  return grades;
}

function discountedGain(grades: readonly number[]): number {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

/**
 * nDCG at `depth` with the gain 2^grade - 1: the order's discounted gain over
 * the best any order of the judged posts could have. Null for a query with no
 * relevant post, which has no best order to compare with.
 */
export function ndcgAt(
  order: readonly string[],
  grades: ReadonlyMap<string, number>,
  depth: number = SEARCH_RELEVANCE_NDCG_DEPTH,
): number | null {
  if (grades.size === 0) return null;
  const ideal = discountedGain([...grades.values()].sort((a, b) => b - a).slice(0, depth));
  if (ideal === 0) return null;
  return discountedGain(order.slice(0, depth).map((key) => grades.get(key) ?? 0)) / ideal;
}

export type SearchRelevanceOrderScore = {
  /** Null for a query with no relevant post. */
  ndcg: number | null;
  /** A post of grade 2 or 3 among the first five. Null for a query with none to find. */
  topHit: boolean | null;
  /** Posts of any grade among the first five. */
  relevantInTop: number;
  /** Posts of no grade among the first ten: for a query about nothing, every post returned. */
  wrongInDepth: number;
};

export function scoreSearchOrder(query: SearchRelevanceQuery, order: readonly string[]): SearchRelevanceOrderScore {
  const grades = searchRelevanceGrades(query);
  const top = order.slice(0, SEARCH_RELEVANCE_TOP_DEPTH);
  const hasTopGrade = [...grades.values()].some((grade) => grade >= SEARCH_RELEVANCE_TOP_GRADE);
  return {
    ndcg: ndcgAt(order, grades),
    topHit: hasTopGrade ? top.some((key) => (grades.get(key) ?? 0) >= SEARCH_RELEVANCE_TOP_GRADE) : null,
    relevantInTop: top.filter((key) => grades.has(key)).length,
    wrongInDepth: order.slice(0, SEARCH_RELEVANCE_NDCG_DEPTH).filter((key) => !grades.has(key)).length,
  };
}

/** One query's two orders, as post keys from the top. */
export type SearchRelevanceRun = { id: string; words: readonly string[]; blended: readonly string[] };

export type SearchRelevanceArmSummary = {
  /** Mean nDCG@10 over the queries with a relevant post. */
  ndcg: number;
  /** Share of those queries with a post of grade 2 or 3 among the first five. */
  topHitRate: number;
  /** Mean number of relevant posts among the first five, over the same queries. */
  relevantInTop: number;
  /** Mean number of wrong posts (of no grade) among the first ten, over the same queries. */
  wrongInDepth: number;
  /** Posts returned, among the first ten, for the queries about nothing. */
  offCorpusPosts: number;
};

export type SearchRelevanceVerdict = {
  queries: number;
  /** Queries with a relevant post: what the means are over. */
  judged: number;
  words: SearchRelevanceArmSummary;
  blended: SearchRelevanceArmSummary;
  byKind: Record<string, { queries: number; words: number; blended: number }>;
  /** Queries whose blended nDCG@10 is under the word order's, worst first: reported, not a failure by themselves. */
  worse: Array<{ id: string; text: string; words: number; blended: number }>;
  /** Why the check fails; empty when it passes. */
  failures: string[];
};

const EPSILON = 1e-9;

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The check. It fails when the blended order
 *
 * - has a lower mean nDCG@10 than the word order, or finds a relevant post
 *   among the first five for fewer queries;
 * - moves a post whose title is the query off the first place the word order
 *   gave it;
 * - returns more posts than the word order for the queries about nothing;
 * - differs from the word order for a one-word query, which is never blended.
 */
export function judgeSearchRelevance(set: SearchRelevanceSet, runs: readonly SearchRelevanceRun[]): SearchRelevanceVerdict {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const failures: string[] = [];
  const rows = set.queries.map((query) => {
    const run = runById.get(query.id);
    if (!run) {
      failures.push(`${query.id} "${query.text}": no run`);
      return null;
    }
    return { query, run, words: scoreSearchOrder(query, run.words), blended: scoreSearchOrder(query, run.blended) };
  }).filter((row): row is NonNullable<typeof row> => row !== null);

  const judged = rows.filter((row) => row.words.ndcg !== null && row.blended.ndcg !== null);
  const summary = (arm: 'words' | 'blended'): SearchRelevanceArmSummary => ({
    ndcg: mean(judged.map((row) => row[arm].ndcg ?? 0)),
    topHitRate: mean(judged.filter((row) => row[arm].topHit !== null).map((row) => (row[arm].topHit ? 1 : 0))),
    relevantInTop: mean(judged.map((row) => row[arm].relevantInTop)),
    wrongInDepth: mean(judged.map((row) => row[arm].wrongInDepth)),
    offCorpusPosts: rows
      .filter((row) => row.query.kind === 'off')
      .reduce((sum, row) => sum + row[arm].wrongInDepth, 0),
  });
  const words = summary('words');
  const blended = summary('blended');

  if (blended.ndcg < words.ndcg - EPSILON) {
    failures.push(`mean nDCG@${SEARCH_RELEVANCE_NDCG_DEPTH} fell: ${words.ndcg.toFixed(4)} by words, ${blended.ndcg.toFixed(4)} blended`);
  }
  if (blended.topHitRate < words.topHitRate - EPSILON) {
    failures.push(`fewer queries have a relevant post in the top ${SEARCH_RELEVANCE_TOP_DEPTH}: ${words.topHitRate.toFixed(4)} by words, ${blended.topHitRate.toFixed(4)} blended`);
  }
  if (blended.offCorpusPosts > words.offCorpusPosts) {
    failures.push(`queries about nothing return more posts: ${words.offCorpusPosts} by words, ${blended.offCorpusPosts} blended`);
  }
  for (const { query, run } of rows) {
    if (query.exactTitle && run.words[0] === query.exactTitle && run.blended[0] !== query.exactTitle) {
      failures.push(`${query.id} "${query.text}": the post with that title lost first place to ${run.blended[0] ?? 'nothing'}`);
    }
    if (searchRelevanceQueryWordCount(query.text) < 2 && run.words.join(' ') !== run.blended.join(' ')) {
      failures.push(`${query.id} "${query.text}": a one-word query was blended`);
    }
  }

  const byKind: SearchRelevanceVerdict['byKind'] = {};
  for (const row of judged) {
    const entry = byKind[row.query.kind] ?? { queries: 0, words: 0, blended: 0 };
    entry.queries += 1;
    entry.words += row.words.ndcg ?? 0;
    entry.blended += row.blended.ndcg ?? 0;
    byKind[row.query.kind] = entry;
  }
  for (const entry of Object.values(byKind)) {
    entry.words /= entry.queries;
    entry.blended /= entry.queries;
  }

  return {
    queries: rows.length,
    judged: judged.length,
    words,
    blended,
    byKind,
    worse: judged
      .filter((row) => (row.blended.ndcg ?? 0) < (row.words.ndcg ?? 0) - EPSILON)
      .map((row) => ({ id: row.query.id, text: row.query.text, words: row.words.ndcg ?? 0, blended: row.blended.ndcg ?? 0 }))
      .sort((a, b) => (a.blended - a.words) - (b.blended - b.words)),
    failures,
  };
}

// ─── A recorded run ─────────────────────────────────────────────────────────

/**
 * What one live run read from the database for a query, kept so the blend can
 * be re-scored where there is no embedding model: the word order with its
 * scores, the nearest posts with their similarities (no floor applied), and
 * the order `search_blended_posts` itself returned.
 */
export type RecordedSearchQueryRun = {
  id: string;
  /** [post key, word score], the word order from its top. */
  words: Array<[string, number]>;
  /** [post key, cosine similarity], nearest first. */
  meaning: Array<[string, number]>;
  /** [post key, how it matched], as the database blended them; the word order for a query that is not blended. */
  blended: Array<[string, SearchMatchSource]>;
};

export type RecordedSearchRun = {
  version: 1;
  recordedAt: string;
  embeddingModel: string;
  constants: SearchBlendConstants;
  queries: RecordedSearchQueryRun[];
};

/** A recorded query's two orders as the judge reads them. */
export function recordedSearchRuns(recorded: RecordedSearchRun): SearchRelevanceRun[] {
  return recorded.queries.map((query) => ({
    id: query.id,
    words: query.words.map(([key]) => key),
    blended: query.blended.map(([key]) => key),
  }));
}
