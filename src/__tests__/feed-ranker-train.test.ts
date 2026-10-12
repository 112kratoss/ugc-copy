import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { mulberry32 } from '@/lib/feed-thompson';
import { normalizeRankedFeedScoreWeights } from '@/lib/showcase-feed-ranking';

import {
  DEFAULT_FEED_RANKER_ACTION_VALUES,
  FEED_RANKER_FACT_COLUMNS,
  FEED_RANKER_FEATURES,
  FEED_RANKER_USAGE,
  FEED_RANKER_WEIGHT_BOUNDS,
  FEED_RANKER_WEIGHT_KEYS,
  FeedRankerUsageError,
  checkFeedRankerSampleFloor,
  effectiveFeedRankerWeights,
  feedRankerDraftDescription,
  feedRankerExampleFromFact,
  feedRankerSampleWeight,
  feedRankerWeightsNormalizerMismatches,
  finalizeFeedRankerWeights,
  fitLogisticRegression,
  isMeaningfulFeedEngagement,
  parseFeedRankerArgs,
  partitionFeedRankerExamples,
  predictLogisticProbability,
  replayFeedRankerSessions,
  runFeedRankerCli,
  splitSessionsForHoldout,
  summarizeFeedRankerDataset,
  trainFeedRanker,
  weightedAuc,
  weightedLogLoss,
  type FeedEngagementOutcome,
  type FeedRankerExample,
  type FeedRankerWeights,
} from '../../scripts/ops/feed-ranker-train';

type Row = Record<string, unknown>;
type QueryError = { message: string; code?: string };
type QueryResult = { data: unknown; error: QueryError | null };

interface FakeQuery extends PromiseLike<QueryResult> {
  eq(column: string, value: unknown): FakeQuery;
  in(column: string, values: readonly unknown[]): FakeQuery;
  gte(column: string, value: string): FakeQuery;
  gt(column: string, value: number): FakeQuery;
  not(column: string, operator: string, value: unknown): FakeQuery;
  order(column: string, options?: { ascending?: boolean }): FakeQuery;
  limit(count: number): FakeQuery;
}

const V1 = '00000000-0000-4000-8000-000000000001';
const V3 = '00000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-10-12T12:00:00.000Z');
const WINDOW_START = '2026-09-12T12:00:00.000Z';
const SERVED = '2026-10-11T08:00:00.000Z';
const AT = '2026-10-11T08:00:05.000Z';

// The v3 row as seeded (FOR_YOU_RULES_V3_*): the live version in these tests.
const LIVE_WEIGHTS = {
  interest_match: 0.24,
  creator_affinity: 0.12,
  smoothed_usefulness: 0.10,
  engagement_depth: 0.22,
  attention_seconds_norm: 0.08,
  freshness: 0.12,
  relevant_trend: 0.08,
  creator_quality: 0.06,
  exploration_ucb: 0.10,
  exploration_bonus: 0.0,
  quick_skip_risk: -0.30,
  negative_feedback_risk: -2.5,
};
const LIVE_POSITIVE_SUM = 1.12;
const LIVE_RETRIEVAL = { candidate_rpc: 'v3', following_limit: 100, cold_limit: 50, seen_penalty: 0.2 };
const LIVE_DIVERSITY = { max_creator_per_20: 3, author_decay: 0.5, cold_start_slot_rank: 6 };

function versionRow(id: string, version: number, status: string, extra: Row = {}): Row {
  return {
    id,
    algorithm_key: 'for-you-rules',
    version,
    status,
    weights: {},
    retrieval_config: {},
    diversity_config: {},
    ...extra,
  };
}

const VERSIONS: Row[] = [
  versionRow(V1, 1, 'retired'),
  versionRow(V3, 3, 'active', {
    weights: LIVE_WEIGHTS,
    retrieval_config: LIVE_RETRIEVAL,
    diversity_config: LIVE_DIVERSITY,
  }),
];

function factRow(overrides: Row = {}): Row {
  return {
    delivery_id: 1,
    session_id: 'session-0001',
    algorithm_version_id: V3,
    position: 0,
    is_exploration: false,
    exploration_propensity: 0,
    score_components: {},
    dwell_ms_max: 0,
    media_progress_max: 0,
    saved_at: null,
    remix_started_at: null,
    resource_opened_at: null,
    purchased_at: null,
    commented_at: null,
    quick_skipped_at: null,
    not_interested_at: null,
    hid_creator_at: null,
    reported_at: null,
    posts: { category: 'image' },
    // Filtered on by the query, not selected.
    served_at: SERVED,
    rendered_at: SERVED,
    ...overrides,
  };
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}

/**
 * Feed sessions whose outcomes follow planted signals: meaningful rises with
 * interest_match, quick skips with quick_skip_risk, negatives with
 * negative_feedback_risk; every other feature is noise, exploration_bonus
 * never varies, and no row stores semantic_similarity.
 */
function syntheticFacts(input: {
  sessions: number;
  perSession: number;
  seed: number;
  versionId?: string;
  firstDeliveryId?: number;
  sessionPrefix?: string;
}): Row[] {
  const random = mulberry32(input.seed);
  const rows: Row[] = [];
  let deliveryId = input.firstDeliveryId ?? 1;
  for (let session = 0; session < input.sessions; session += 1) {
    for (let position = 0; position < input.perSession; position += 1) {
      const interest = random();
      const skipRisk = random();
      const negativeRisk = random();
      const components = {
        interest_match: interest,
        creator_affinity: random(),
        smoothed_usefulness: random(),
        freshness: random(),
        relevant_trend: random(),
        exploration_bonus: 0,
        quick_skip_risk: skipRisk,
        negative_feedback_risk: negativeRisk,
        engagement_depth: random(),
        attention_seconds_norm: random(),
        creator_quality: random(),
        exploration_ucb: random(),
        seen_recently: false,
        is_following: random() < 0.2,
        served_recently: random() < 0.1,
        ranking: { base: 0.5, offset: 0.5 },
      };
      const meaningful = random() < sigmoid(12 * (interest - 0.5));
      const quickSkip = random() < sigmoid(12 * (skipRisk - 0.55));
      const negative = random() < sigmoid(14 * (negativeRisk - 0.8));
      rows.push(factRow({
        delivery_id: deliveryId,
        session_id: `${input.sessionPrefix ?? 'session'}-${String(session).padStart(4, '0')}`,
        algorithm_version_id: input.versionId ?? V3,
        position,
        score_components: components,
        dwell_ms_max: meaningful ? 4500 : 800,
        quick_skipped_at: quickSkip ? AT : null,
        not_interested_at: negative ? AT : null,
      }));
      deliveryId += 1;
    }
  }
  return rows;
}

type FakeSeed = {
  versions?: Row[];
  facts?: Row[];
  rpcResults?: Record<string, QueryResult>;
  tableErrors?: Record<string, QueryError>;
};

function createFakeClient(seed: FakeSeed = {}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const queries: Array<{ table: string; columns: string; calls: string[] }> = [];

  function query(table: string, rows: readonly Row[], calls: string[]): FakeQuery {
    let filtered = [...rows];
    let orderColumn: string | null = null;
    let ascending = true;
    let limit = Number.POSITIVE_INFINITY;
    const execute = (): Promise<QueryResult> => {
      const error = seed.tableErrors?.[table] ?? null;
      if (error) return Promise.resolve({ data: null, error });
      const sorted = orderColumn === null
        ? filtered
        : [...filtered].sort((left, right) => {
          const column = orderColumn as string;
          const order = Number(left[column]) - Number(right[column]);
          return ascending ? order : -order;
        });
      return Promise.resolve({ data: sorted.slice(0, limit), error: null });
    };
    const builder: FakeQuery = {
      eq(column, value) {
        calls.push(`eq ${column} ${String(value)}`);
        filtered = filtered.filter((row) => row[column] === value);
        return builder;
      },
      in(column, values) {
        calls.push(`in ${column} ${values.join(',')}`);
        filtered = filtered.filter((row) => values.includes(row[column]));
        return builder;
      },
      gte(column, value) {
        calls.push(`gte ${column} ${value}`);
        filtered = filtered.filter((row) => typeof row[column] === 'string' && (row[column] as string) >= value);
        return builder;
      },
      gt(column, value) {
        calls.push(`gt ${column} ${value}`);
        filtered = filtered.filter((row) => Number(row[column]) > value);
        return builder;
      },
      not(column, operator, value) {
        calls.push(`not ${column} ${operator} ${String(value)}`);
        filtered = filtered.filter((row) => row[column] !== null && row[column] !== undefined);
        return builder;
      },
      order(column, options) {
        calls.push(`order ${column} ${options?.ascending === false ? 'desc' : 'asc'}`);
        orderColumn = column;
        ascending = options?.ascending !== false;
        return builder;
      },
      limit(count) {
        calls.push(`limit ${count}`);
        limit = count;
        return builder;
      },
      then(onfulfilled, onrejected) {
        return execute().then(onfulfilled, onrejected);
      },
    };
    return builder;
  }

  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const calls: string[] = [];
          queries.push({ table, columns, calls });
          if (table === 'feed_algorithm_versions') return query(table, seed.versions ?? VERSIONS, calls);
          if (table === 'feed_delivery_facts') return query(table, seed.facts ?? [], calls);
          throw new Error(`Unexpected table: ${table}`);
        },
      };
    },
    async rpc(name: string, args: unknown): Promise<QueryResult> {
      rpcCalls.push({ name, args });
      return seed.rpcResults?.[name] ?? { data: { rpc: name }, error: null };
    },
  };

  return { client: client as unknown as SupabaseClient, rpcCalls, queries };
}

async function run(argv: string[], seed?: FakeSeed) {
  const fake = createFakeClient(seed);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runFeedRankerCli(argv, {
    client: fake.client,
    now: () => NOW,
    output: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
  });
  return {
    exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    rpcCalls: fake.rpcCalls,
    queries: fake.queries,
  };
}

const FEATURE_INDEX = (name: string) => FEED_RANKER_FEATURES.indexOf(name);

function weightsCamelCase(weights: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    value,
  ]));
}

describe('parseFeedRankerArgs', () => {
  it('parses each command with its defaults', () => {
    expect(parseFeedRankerArgs(['dataset'])).toEqual({ command: 'dataset', days: 30, algorithmKey: 'for-you-rules' });
    expect(parseFeedRankerArgs(['train'])).toEqual({
      command: 'train',
      days: 30,
      algorithmKey: 'for-you-rules',
      values: { meaningful: 1, quick_skip: -0.5, negative: -3 },
      minRendered: 500,
      minPositives: 50,
      apply: false,
      force: false,
    });
    expect(parseFeedRankerArgs(['replay', '--weights', '{"interest_match": 0.3}'])).toEqual({
      command: 'replay',
      days: 30,
      algorithmKey: 'for-you-rules',
      weights: { interest_match: 0.3 },
    });
  });

  it('parses every train option', () => {
    expect(parseFeedRankerArgs([
      'train', '--days', '14', '--value-meaningful', '2', '--value-skip', '-1.25', '--value-negative', '0',
      '--min-rendered', '0', '--min-positives', '10', '--algorithm-key', 'for-you-rules', '--apply', '--force',
    ])).toEqual({
      command: 'train',
      days: 14,
      algorithmKey: 'for-you-rules',
      values: { meaningful: 2, quick_skip: -1.25, negative: 0 },
      minRendered: 0,
      minPositives: 10,
      apply: true,
      force: true,
    });
  });

  it('reads help anywhere on the line', () => {
    expect(parseFeedRankerArgs(['help'])).toEqual({ command: 'help' });
    expect(parseFeedRankerArgs(['train', '--apply', '--help'])).toEqual({ command: 'help' });
  });

  it.each<[string[], RegExp]>([
    [[], /Missing command/],
    [['fit'], /Unknown command: fit/],
    [['dataset', '--apply'], /Unknown option: --apply/],
    [['replay', '--weights', '{}', '--apply'], /Unknown option: --apply/],
    [['dataset', '--days', '0'], /--days must be a whole number from 1 to 30/],
    [['dataset', '--days', '31'], /--days must be a whole number from 1 to 30/],
    [['train', '--days', '7.5'], /--days must be a whole number/],
    [['train', '--min-positives', '-1'], /--min-positives must be a whole number/],
    [['train', '--min-rendered', 'many'], /--min-rendered must be a whole number/],
    [['train', '--value-skip', 'half'], /--value-skip must be a number from -100 to 100/],
    [['train', '--value-negative', '-101'], /--value-negative must be a number from -100 to 100/],
    [['train', '--value-meaningful', '0', '--value-skip', '0', '--value-negative', '0'], /must not be 0/],
    [['train', '--min-postives', '10'], /Unknown option: --min-postives/],
    [['train', '--days', '7', '--days', '8'], /Duplicate option: --days/],
    [['train', '--days'], /Missing value for --days/],
    [['train', 'now'], /Unexpected argument: now/],
    [['train', '--algorithm-key', 'k'.repeat(81)], /at most 80 characters/],
    [['replay'], /--weights is required/],
    [['replay', '--weights', 'interest_match=1'], /--weights must be a JSON object/],
    [['replay', '--weights', '[0.2]'], /--weights must be a JSON object/],
    [['replay', '--weights', '{"interest_macth": 0.2}'], /unknown key: interest_macth/],
    [['replay', '--weights', '{"freshness": 11}'], /--weights freshness must be a number from -10 to 10/],
    [['replay', '--weights', '{"freshness": "0.2"}'], /--weights freshness must be a number/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseFeedRankerArgs(argv)).toThrow(FeedRankerUsageError);
    expect(() => parseFeedRankerArgs(argv)).toThrow(message);
  });
});

describe('labels: is_meaningful_feed_engagement in TypeScript', () => {
  const NOTHING: FeedEngagementOutcome = {
    category: 'image',
    mediaProgressMax: 0,
    dwellMsMax: 0,
    savedAt: null,
    remixStartedAt: null,
    resourceOpenedAt: null,
    purchasedAt: null,
    commentedAt: null,
  };

  // Expected values evaluated by hand from the SQL body:
  //   (p_category = 'video' AND coalesce(p_media_progress_max, 0) >= 0.5)
  //   OR (coalesce(p_category, '') <> 'video' AND coalesce(p_dwell_ms_max, 0) >= 3000)
  //   OR saved / remix started / resource opened / purchased / (v4) commented IS NOT NULL
  it.each<[string, Partial<FeedEngagementOutcome>, boolean]>([
    ['nothing happened', {}, false],
    ['a video played to half', { category: 'video', mediaProgressMax: 0.5 }, true],
    ['a video played just short of half', { category: 'video', mediaProgressMax: 0.4999 }, false],
    ['a video held 10 s but under half: video reads progress only', {
      category: 'video', mediaProgressMax: 0.2, dwellMsMax: 10_000,
    }, false],
    ['a video with null progress and dwell', { category: 'video', mediaProgressMax: null, dwellMsMax: null }, false],
    ['an image held 3 s', { dwellMsMax: 3000 }, true],
    ['an image held 2.999 s', { dwellMsMax: 2999 }, false],
    ['an image at full progress: a still reads dwell only', { mediaProgressMax: 1 }, false],
    ['a text post held 3 s', { category: 'text', dwellMsMax: 3000 }, true],
    ['no category takes the dwell rule', { category: null, dwellMsMax: 3000 }, true],
    ['no category ignores progress', { category: null, mediaProgressMax: 1 }, false],
    ['only the literal video category is video', { category: 'motion', mediaProgressMax: 1 }, false],
    ['a save', { savedAt: AT }, true],
    ['a remix start', { remixStartedAt: AT }, true],
    ['a resource open', { resourceOpenedAt: AT }, true],
    ['a purchase', { purchasedAt: AT }, true],
    ['a comment (v4 p_commented_at)', { commentedAt: AT }, true],
    ['a save on a video watched for a second', { category: 'video', mediaProgressMax: 0.05, savedAt: AT }, true],
  ])('%s', (_, overrides, expected) => {
    expect(isMeaningfulFeedEngagement({ ...NOTHING, ...overrides })).toBe(expected);
  });

  it('labels a fact row from its outcome columns and the post category', () => {
    const label = (overrides: Row) => feedRankerExampleFromFact(factRow(overrides)).labels;
    expect(label({})).toEqual({ meaningful: false, quick_skip: false, negative: false });
    expect(label({ posts: { category: 'video' }, media_progress_max: 0.5 }).meaningful).toBe(true);
    expect(label({ posts: { category: 'video' }, dwell_ms_max: 9000 }).meaningful).toBe(false);
    expect(label({ posts: { category: 'image' }, dwell_ms_max: 3000 }).meaningful).toBe(true);
    expect(label({ posts: null, dwell_ms_max: 3000 }).meaningful).toBe(true);
    expect(label({ posts: [{ category: 'video' }], media_progress_max: 0.75 }).meaningful).toBe(true);
    for (const column of ['saved_at', 'remix_started_at', 'resource_opened_at', 'purchased_at', 'commented_at']) {
      expect(label({ [column]: AT }).meaningful).toBe(true);
    }
    expect(label({ quick_skipped_at: AT })).toEqual({ meaningful: false, quick_skip: true, negative: false });
    for (const column of ['not_interested_at', 'hid_creator_at', 'reported_at']) {
      expect(label({ [column]: AT })).toEqual({ meaningful: false, quick_skip: false, negative: true });
    }
  });
});

describe('features and sample weights', () => {
  it('reads the weight keys from score_components as the scorer does, then the control features', () => {
    const example = feedRankerExampleFromFact(factRow({
      position: 7,
      is_exploration: true,
      exploration_propensity: 1,
      score_components: {
        interest_match: 0.4,
        creator_affinity: 1.7,
        freshness: -0.2,
        quick_skip_risk: '0.25',
        engagement_depth: Number.NaN,
        is_following: true,
        served_recently: false,
        ranking: { base: 3 },
      },
    }));
    expect(FEED_RANKER_FEATURES).toEqual([...FEED_RANKER_WEIGHT_KEYS, 'position', 'is_following', 'served_recently', 'is_exploration']);
    const features = Object.fromEntries(FEED_RANKER_FEATURES.map((name, index) => [name, example.features[index]]));
    expect(features).toMatchObject({
      interest_match: 0.4,
      creator_affinity: 1, // clamped to [0, 1]
      freshness: 0,
      quick_skip_risk: 0.25,
      engagement_depth: 0,
      semantic_similarity: 0, // missing reads as 0
      position: 7,
      is_following: 1,
      served_recently: 0,
      is_exploration: 1,
    });
    expect(example.hasSemanticSimilarity).toBe(false);
    expect(feedRankerExampleFromFact(factRow({ score_components: { semantic_similarity: 0.6 } })).features[
      FEATURE_INDEX('semantic_similarity')
    ]).toBe(0.6);
  });

  it('weights a row by 1 / propensity only for a propensity in (0, 1]', () => {
    expect(feedRankerSampleWeight(0)).toBe(1);
    expect(feedRankerSampleWeight(1)).toBe(1);
    expect(feedRankerSampleWeight(0.25)).toBe(4);
    expect(feedRankerSampleWeight(null)).toBe(1);
    expect(feedRankerSampleWeight(1.5)).toBe(1);
    expect(feedRankerSampleWeight(Number.NaN)).toBe(1);
    expect(feedRankerSampleWeight(-0.5)).toBe(1);
  });

  it('fails loudly on a fact without its key columns', () => {
    expect(() => feedRankerExampleFromFact(factRow({ session_id: null }))).toThrow(
      'feed_delivery_facts returned a row without session_id.',
    );
    expect(() => feedRankerExampleFromFact(factRow({ position: 1.5 }))).toThrow('without a whole position');
  });
});

describe('holdout split by session', () => {
  const sessionIds = Array.from({ length: 100 }, (_, index) => `session-${index}`);

  it('holds out a fifth of the sessions, the same ones whatever the row order', () => {
    const holdout = splitSessionsForHoldout(sessionIds);
    expect(holdout.size).toBe(20);
    expect(splitSessionsForHoldout([...sessionIds].reverse())).toEqual(holdout);
    expect(splitSessionsForHoldout([...sessionIds, ...sessionIds])).toEqual(holdout);
    expect(splitSessionsForHoldout(sessionIds, 7)).not.toEqual(holdout);
  });

  it('keeps at least one session on each side once there are two', () => {
    expect(splitSessionsForHoldout(['only']).size).toBe(0);
    expect(splitSessionsForHoldout(['a', 'b']).size).toBe(1);
    expect(splitSessionsForHoldout(['a', 'b', 'c']).size).toBe(1);
  });

  it('never splits a session across train and holdout', () => {
    const examples = syntheticFacts({ sessions: 40, perSession: 6, seed: 3 }).map(feedRankerExampleFromFact);
    const { train, holdout, holdoutSessions } = partitionFeedRankerExamples(examples);
    expect(train.length + holdout.length).toBe(examples.length);
    expect(holdoutSessions.size).toBe(8);
    const trainSessions = new Set(train.map((example) => example.sessionId));
    for (const example of holdout) expect(trainSessions.has(example.sessionId)).toBe(false);
    expect(new Set(holdout.map((example) => example.sessionId))).toEqual(holdoutSessions);
    expect(holdout).toHaveLength(8 * 6);
  });
});

describe('logistic regression', () => {
  function plantedRows(count: number, seed: number) {
    const random = mulberry32(seed);
    const features: number[][] = [];
    const labels: boolean[] = [];
    for (let index = 0; index < count; index += 1) {
      const signal = random();
      const noise = random();
      const inverse = random();
      features.push([signal, noise, inverse, 0.5]);
      // Separable: the label is exactly signal > 0.5 unless inverse < 0.1.
      labels.push(signal > 0.5 || inverse < 0.1);
    }
    return { features, labels, weights: features.map(() => 1) };
  }

  it('recovers a planted separable signal: coefficient signs and holdout AUC above 0.9', () => {
    const train = plantedRows(1500, 11);
    const holdout = plantedRows(500, 12);
    const model = fitLogisticRegression(train.features, train.labels, train.weights);
    const [signal, noise, inverse, constant] = model.standardizedCoefficients;
    expect(signal).toBeGreaterThan(1);
    expect(inverse).toBeLessThan(0);
    expect(Math.abs(noise)).toBeLessThan(Math.abs(signal) / 10);
    expect(constant).toBe(0);
    expect(model.scales[3]).toBe(0);
    expect(model.coefficients[3]).toBe(0);

    const scores = holdout.features.map((row) => predictLogisticProbability(model, row));
    expect(scores.every((score) => score > 0 && score < 1)).toBe(true);
    expect(weightedAuc(scores, holdout.labels, holdout.weights)).toBeGreaterThan(0.9);
    const rate = holdout.labels.filter(Boolean).length / holdout.labels.length;
    expect(weightedLogLoss(scores, holdout.labels, holdout.weights)).toBeLessThan(
      weightedLogLoss(holdout.labels.map(() => rate), holdout.labels, holdout.weights) as number,
    );
  });

  it('stops at the training rate when no feature varies', () => {
    const features = Array.from({ length: 40 }, () => [1, 0]);
    const labels = features.map((_, index) => index % 4 === 0);
    const model = fitLogisticRegression(features, labels, features.map(() => 1));
    expect(model.converged).toBe(true);
    expect(predictLogisticProbability(model, [1, 0])).toBeCloseTo(0.25, 6);
    expect(model.standardizedCoefficients).toEqual([0, 0]);
  });

  it('weights rows: a row weighing 3 counts as three rows', () => {
    const features = [[0], [1], [1], [0], [1]];
    const labels = [false, true, false, true, true];
    const weighted = fitLogisticRegression(features, labels, [3, 1, 1, 1, 1]);
    const repeated = fitLogisticRegression(
      [[0], [0], [0], [1], [1], [0], [1]],
      [false, false, false, true, false, true, true],
      [1, 1, 1, 1, 1, 1, 1],
    );
    expect(weighted.coefficients[0]).toBeCloseTo(repeated.coefficients[0], 5);
    expect(weighted.intercept).toBeCloseTo(repeated.intercept, 5);
  });

  it('scores AUC by rank with ties at half, and log-loss against the truth', () => {
    expect(weightedAuc([0.1, 0.2, 0.8, 0.9], [false, false, true, true], [1, 1, 1, 1])).toBe(1);
    expect(weightedAuc([0.9, 0.8, 0.2, 0.1], [false, false, true, true], [1, 1, 1, 1])).toBe(0);
    expect(weightedAuc([0.5, 0.5, 0.5, 0.5], [false, true, false, true], [1, 1, 1, 1])).toBe(0.5);
    expect(weightedAuc([0.1, 0.9], [true, true], [1, 1])).toBeNull();
    expect(weightedLogLoss([0.5, 0.5], [true, false], [1, 1])).toBeCloseTo(Math.LN2, 12);
    expect(weightedLogLoss([], [], [])).toBeNull();
  });
});

describe('trainFeedRanker', () => {
  const liveWeights = effectiveFeedRankerWeights(LIVE_WEIGHTS);
  const examples = syntheticFacts({ sessions: 60, perSession: 12, seed: 7 }).map(feedRankerExampleFromFact);
  const result = trainFeedRanker(examples, { values: DEFAULT_FEED_RANKER_ACTION_VALUES, liveWeights });
  const fit = (action: string) => result.fits.find((entry) => entry.action === action)!;

  it('fits each action on the training sessions and scores it on the holdout sessions', () => {
    expect(result.trainSessions).toBe(48);
    expect(result.holdoutSessions).toBe(12);
    expect(result.trainRows + result.holdoutRows).toBe(720);
    for (const action of ['meaningful', 'quick_skip', 'negative']) {
      expect(fit(action).model).not.toBeNull();
      expect(fit(action).holdoutAuc).toBeGreaterThan(0.75);
      expect(fit(action).holdoutLogLoss).toBeLessThan(fit(action).baselineLogLoss as number);
    }
    expect(fit('meaningful').model!.standardizedCoefficients[FEATURE_INDEX('interest_match')]).toBeGreaterThan(1);
    expect(fit('quick_skip').model!.standardizedCoefficients[FEATURE_INDEX('quick_skip_risk')]).toBeGreaterThan(1);
    expect(fit('negative').model!.standardizedCoefficients[FEATURE_INDEX('negative_feedback_risk')]).toBeGreaterThan(1);
  });

  it('linearises the value model at the training means with position at the top slot', () => {
    expect(result.evaluationPoint[FEATURE_INDEX('position')]).toBe(0);
    expect(result.evaluationPoint[FEATURE_INDEX('interest_match')]).toBeGreaterThan(0.4);
    // w_k = Σ_a value_a · coef_{a,k} · p̂_a(1 − p̂_a), recomputed by hand for one key.
    const index = FEATURE_INDEX('interest_match');
    const expected = result.fits.reduce((sum, entry) => (
      sum + entry.value * entry.model!.coefficients[index] * entry.probabilityAtServe * (1 - entry.probabilityAtServe)
    ), 0);
    expect(result.linearizedWeights.interest_match).toBeCloseTo(expected, 12);
    expect(fit('meaningful').probabilityAtServe).toBe(
      predictLogisticProbability(fit('meaningful').model!, result.evaluationPoint),
    );
  });

  it('emits every weight key: planted signs, unlearnable keys at 0, positives summing to the live sum', () => {
    expect(Object.keys(result.weights)).toEqual([...FEED_RANKER_WEIGHT_KEYS]);
    expect(result.weights.interest_match).toBeGreaterThan(0);
    expect(result.weights.quick_skip_risk).toBeLessThan(0);
    expect(result.weights.negative_feedback_risk).toBeLessThan(0);
    expect(result.unvariedKeys).toEqual(['exploration_bonus', 'semantic_similarity']);
    expect(result.weights.exploration_bonus).toBe(0);
    expect(result.weights.semantic_similarity).toBe(0);
    expect(result.rescale.livePositiveSum).toBeCloseTo(LIVE_POSITIVE_SUM, 12);
    const positiveSum = FEED_RANKER_WEIGHT_KEYS.reduce((sum, key) => sum + Math.max(0, result.weights[key]), 0);
    expect(positiveSum).toBeCloseTo(LIVE_POSITIVE_SUM, 2);
  });

  it('produces weights that pass the normaliser unchanged', () => {
    expect(feedRankerWeightsNormalizerMismatches(result.weights)).toEqual([]);
    const normalized = normalizeRankedFeedScoreWeights(result.weights) as unknown as Record<string, number>;
    const camel = weightsCamelCase(result.weights);
    // Every key the feed reads is fitted, and reads back exactly as fitted.
    for (const key of Object.keys(normalized)) {
      expect(camel).toHaveProperty(key);
      expect(normalized[key]).toBe(camel[key]);
    }
    for (const value of Object.values(result.weights)) {
      expect(value).toBeGreaterThanOrEqual(FEED_RANKER_WEIGHT_BOUNDS.min);
      expect(value).toBeLessThanOrEqual(FEED_RANKER_WEIGHT_BOUNDS.max);
    }
  });

  it('replays the holdout sessions with the live and the fitted weights', () => {
    expect(result.replay.sessions).toBe(12);
    expect(result.replay.topK).toBe(12);
    expect(result.replay.logged.items).toBe(12 * 12);
    expect(result.replay.live.items).toBe(12 * 12);
    expect(result.replay.candidate.items).toBe(12 * 12);
    // 12 items per session: nothing to reorder out of a top 12.
    expect(result.replay.sessionsAboveTopK).toBe(0);
    expect(result.replay.candidate.meaningful).toBe(result.replay.logged.meaningful);
  });

  it('is deterministic', () => {
    const again = trainFeedRanker(examples, { values: DEFAULT_FEED_RANKER_ACTION_VALUES, liveWeights });
    expect(again.weights).toEqual(result.weights);
    expect(again.fits.map((entry) => entry.holdoutAuc)).toEqual(result.fits.map((entry) => entry.holdoutAuc));
  });

  it('skips an action without a positive in the training rows', () => {
    const quiet = examples.map((example) => ({ ...example, labels: { ...example.labels, negative: false } }));
    const trained = trainFeedRanker(quiet, { values: DEFAULT_FEED_RANKER_ACTION_VALUES, liveWeights });
    const negative = trained.fits.find((entry) => entry.action === 'negative')!;
    expect(negative.model).toBeNull();
    expect(negative.holdoutAuc).toBeNull();
    expect(negative.trainPositives).toBe(0);
    expect(negative.probabilityAtServe).toBe(0);
    // The weight then comes from the two fitted models alone.
    const index = FEATURE_INDEX('negative_feedback_risk');
    const fromFitted = trained.fits.reduce((sum, entry) => (
      entry.model
        ? sum + entry.value * entry.model.coefficients[index] * entry.probabilityAtServe * (1 - entry.probabilityAtServe)
        : sum
    ), 0);
    expect(trained.linearizedWeights.negative_feedback_risk).toBeCloseTo(fromFitted, 12);
    expect(Math.abs(trained.weights.negative_feedback_risk)).toBeLessThan(Math.abs(result.weights.negative_feedback_risk));
  });
});

describe('finalizeFeedRankerWeights', () => {
  const zero = Object.fromEntries(FEED_RANKER_WEIGHT_KEYS.map((key) => [key, 0])) as FeedRankerWeights;

  it('scales every weight by live positive sum ÷ fitted positive sum, then clamps into the normaliser bounds', () => {
    const live = { ...zero, interest_match: 0.6, freshness: 0.4, quick_skip_risk: -0.3 };
    const linearized = { ...zero, interest_match: 0.02, freshness: 0.03, quick_skip_risk: -0.01, negative_feedback_risk: -1 };
    const { weights, rescale, clampedKeys } = finalizeFeedRankerWeights(linearized, live);
    expect(rescale).toEqual({ livePositiveSum: 1, fittedPositiveSum: 0.05, factor: 20 });
    expect(weights.interest_match).toBeCloseTo(0.4, 12);
    expect(weights.freshness).toBeCloseTo(0.6, 12);
    expect(weights.quick_skip_risk).toBeCloseTo(-0.2, 12);
    // −1 × 20 = −20 would read as the v1 default (−0.8): clamped instead.
    expect(weights.negative_feedback_risk).toBe(-10);
    expect(clampedKeys).toEqual(['negative_feedback_risk']);
    expect(Object.keys(weights)).toEqual([...FEED_RANKER_WEIGHT_KEYS]);
    expect(feedRankerWeightsNormalizerMismatches(weights)).toEqual([]);
  });

  it('keeps the fitted scale when no fitted weight is positive', () => {
    const { weights, rescale } = finalizeFeedRankerWeights({ ...zero, quick_skip_risk: -0.12345678 }, effectiveFeedRankerWeights(LIVE_WEIGHTS));
    expect(rescale.factor).toBeNull();
    expect(weights.quick_skip_risk).toBe(-0.1235);
    expect(Object.is(weights.freshness, 0)).toBe(true);
  });
});

describe('effectiveFeedRankerWeights and the normaliser check', () => {
  it('reads a stored weights JSON as the feed does', () => {
    const weights = effectiveFeedRankerWeights({ interest_match: 0.5, freshness: 12 });
    expect(weights.interest_match).toBe(0.5);
    // Out of bounds and missing keys take the normaliser's (v1) defaults.
    expect(weights.freshness).toBe(0.15);
    expect(weights.negative_feedback_risk).toBe(-0.8);
    expect(Object.keys(weights)).toEqual([...FEED_RANKER_WEIGHT_KEYS]);
  });

  it('reports a key the feed reads that is missing, and a value it would replace', () => {
    const complete = effectiveFeedRankerWeights(LIVE_WEIGHTS);
    const withoutFreshness: Record<string, number> = { ...complete };
    delete withoutFreshness.freshness;
    expect(feedRankerWeightsNormalizerMismatches(withoutFreshness)).toEqual(['freshness is read by the feed but not fitted']);
    expect(feedRankerWeightsNormalizerMismatches({ ...complete, interest_match: 11 })).toEqual([
      'interest_match 11 reads as 0.35',
    ]);
  });
});

describe('replayFeedRankerSessions', () => {
  it('re-ranks each session by base score and counts outcomes in the top 12', () => {
    const zero = Object.fromEntries(FEED_RANKER_WEIGHT_KEYS.map((key) => [key, 0])) as FeedRankerWeights;
    const items: FeedRankerExample[] = Array.from({ length: 14 }, (_, position) => feedRankerExampleFromFact(factRow({
      delivery_id: position + 1,
      session_id: 'replayed',
      position,
      // The two items served last carry the outcomes and the highest freshness.
      score_components: { interest_match: position / 14, freshness: position >= 12 ? 1 : 0 },
      dwell_ms_max: position >= 12 ? 5000 : 0,
      quick_skipped_at: position < 2 ? AT : null,
    })));
    const replay = replayFeedRankerSessions(
      items,
      { ...zero, interest_match: -1 },
      { ...zero, freshness: 1 },
    );
    expect(replay.sessions).toBe(1);
    expect(replay.sessionsAboveTopK).toBe(1);
    expect(replay.logged).toEqual({ items: 12, meaningful: 0, quickSkips: 2 });
    // Lowest interest first: the same as served.
    expect(replay.live).toEqual({ items: 12, meaningful: 0, quickSkips: 2 });
    // Freshness lifts the last two; ties keep the served order, so items 12, 13, 0..9.
    expect(replay.candidate).toEqual({ items: 12, meaningful: 2, quickSkips: 2 });
  });
});

describe('sample floor and the draft', () => {
  const values = DEFAULT_FEED_RANKER_ACTION_VALUES;
  const counts = (rows: number, meaningful: number, quickSkip: number, negative: number) => ({
    rows, sessions: 10, positives: { meaningful, quick_skip: quickSkip, negative },
  });

  it('passes at the floor and names every shortfall below it', () => {
    expect(checkFeedRankerSampleFloor(counts(500, 50, 50, 50), { minRendered: 500, minPositives: 50, values }).passed).toBe(true);
    const below = checkFeedRankerSampleFloor(counts(499, 49, 50, 3), { minRendered: 500, minPositives: 50, values });
    expect(below.passed).toBe(false);
    expect(below.failures).toEqual([
      'rendered 499 < 500',
      'meaningful positives 49 < 50',
      'negative positives 3 < 50',
    ]);
  });

  it('does not hold an action valued 0 to the floor', () => {
    const check = checkFeedRankerSampleFloor(counts(800, 90, 70, 2), {
      minRendered: 500, minPositives: 50, values: { ...values, negative: 0 },
    });
    expect(check.passed).toBe(true);
    expect(check.lines).toContain('  negative positives 2: not checked (value 0)');
  });

  it('describes the draft with its date, sample, AUCs and values', () => {
    const fits = trainFeedRanker(
      syntheticFacts({ sessions: 20, perSession: 10, seed: 5 }).map(feedRankerExampleFromFact),
      { values, liveWeights: effectiveFeedRankerWeights(LIVE_WEIGHTS) },
    ).fits.map((entry) => (entry.action === 'negative' ? { ...entry, holdoutAuc: null } : entry));
    expect(feedRankerDraftDescription({ now: NOW, rendered: 200, days: 14, values, fits })).toMatch(
      /^Fitted 2026-10-12: 200 rendered, AUC meaningful\/skip\/negative [01]\.\d{3}\/[01]\.\d{3}\/– \(14-day window, values 1\/-0\.5\/-3\)\.$/,
    );
  });
});

describe('runFeedRankerCli: usage, environment and exit codes', () => {
  it('prints the usage and exits 1 for an unknown command, before building any client', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runFeedRankerCli(['fit'], {
      environment: { NODE_ENV: 'test' },
      output: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
    });
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Unknown command: fit');
    expect(stderr.join('\n')).toContain(FEED_RANKER_USAGE);
    expect(stdout).toEqual([]);
  });

  it('prints the usage and exits 0 for help', async () => {
    const result = await run(['help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(FEED_RANKER_USAGE);
    expect(result.queries).toEqual([]);
  });

  it('exits 1 without echoing the key when the environment is incomplete', async () => {
    const lines: string[] = [];
    const exitCode = await runFeedRankerCli(['dataset'], {
      environment: { NODE_ENV: 'test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value' },
      output: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    });
    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    expect(lines.join('\n')).not.toContain('service-role-test-value');
  });

  it('points at the v4 migration when a column is missing', async () => {
    const result = await run(['dataset'], {
      tableErrors: {
        feed_delivery_facts: { message: 'column feed_delivery_facts.commented_at does not exist', code: '42703' },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Reading feed_delivery_facts failed: column feed_delivery_facts.commented_at does not exist '
      + '(42703; is the feed ranking v4 migration applied?)',
    );
  });

  it('exits 1 when the key has no versions', async () => {
    const result = await run(['dataset', '--algorithm-key', 'nobody']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No nobody versions in feed_algorithm_versions.');
  });
});

describe('dataset', () => {
  it('reads the rendered facts of the key\'s versions in the window, paged by delivery id', async () => {
    const facts = [
      ...syntheticFacts({ sessions: 100, perSession: 20, seed: 1 }),
      ...syntheticFacts({
        sessions: 25, perSession: 20, seed: 2, versionId: V1, firstDeliveryId: 2001, sessionPrefix: 'v1-session',
      }),
      factRow({ delivery_id: 9001, rendered_at: null }),
      factRow({ delivery_id: 9002, served_at: '2026-09-01T00:00:00.000Z' }),
      factRow({ delivery_id: 9003, algorithm_version_id: 'another-key-version' }),
    ];
    const result = await run(['dataset'], { facts });
    expect(result.exitCode).toBe(0);

    expect(result.queries[0]).toEqual({
      table: 'feed_algorithm_versions',
      columns: 'id, algorithm_key, version, status, weights, retrieval_config, diversity_config',
      calls: ['eq algorithm_key for-you-rules', 'order version asc'],
    });
    const pages = result.queries.slice(1);
    expect(pages.map((page) => page.table)).toEqual(Array(4).fill('feed_delivery_facts'));
    expect(pages[0]).toEqual({
      table: 'feed_delivery_facts',
      columns: FEED_RANKER_FACT_COLUMNS,
      calls: [
        `in algorithm_version_id ${V1},${V3}`,
        `gte served_at ${WINDOW_START}`,
        'not rendered_at is null',
        'order delivery_id asc',
        'limit 1000',
      ],
    });
    expect(pages.slice(1).map((page) => page.calls.find((call) => call.startsWith('gt ')))).toEqual([
      'gt delivery_id 1000',
      'gt delivery_id 2000',
      'gt delivery_id 2500',
    ]);
    expect(FEED_RANKER_FACT_COLUMNS).toContain('commented_at');
    expect(FEED_RANKER_FACT_COLUMNS).toContain('posts(category)');

    expect(result.stdout).toContain(
      'Feed ranker dataset: rendered for-you-rules deliveries served in the last 30 days (feed_delivery_facts).',
    );
    expect(result.stdout).toContain('rendered 2500 · sessions 125 · exploration picks 0');
    expect(result.stdout).toMatch(/positives: meaningful \d+ \(\d+\.\d%\) · quick skip \d+ \(\d+\.\d%\) · negative \d+/);
    expect(result.stdout).toContain('semantic_similarity is stored on 0 of 2500 rows');
    expect(result.stdout).toContain('Sample weights: every row weighs 1.');
    expect(result.stdout).toContain('logs 1 for an exploration pick and 0 for everything else');
    expect(result.stdout).toMatch(/for-you-rules-v3\s+2000\s+100\s/);
    expect(result.stdout).toMatch(/for-you-rules-v1\s+500\s+25\s/);
    expect(result.rpcCalls).toEqual([]);
  });

  it('counts positives per action and version, and says when a propensity reweights rows', () => {
    const examples = [
      factRow({ delivery_id: 1, saved_at: AT, exploration_propensity: 0.5, is_exploration: true }),
      factRow({ delivery_id: 2, session_id: 'session-0002', quick_skipped_at: AT }),
      factRow({ delivery_id: 3, session_id: 'session-0002', algorithm_version_id: V1, reported_at: AT }),
    ].map(feedRankerExampleFromFact);
    const summary = summarizeFeedRankerDataset(examples);
    expect(summary).toMatchObject({
      rows: 3,
      sessions: 2,
      positives: { meaningful: 1, quick_skip: 1, negative: 1 },
      explorationRows: 1,
      reweightedRows: 1,
      maxSampleWeight: 2,
      byVersion: [
        { algorithmVersionId: V3, rows: 2, sessions: 2, positives: { meaningful: 1, quick_skip: 1, negative: 0 } },
        { algorithmVersionId: V1, rows: 1, sessions: 1, positives: { meaningful: 0, quick_skip: 0, negative: 1 } },
      ],
    });
  });

  it('says when nothing was rendered, and needs no active version', async () => {
    const result = await run(['dataset', '--days', '1'], {
      versions: [versionRow(V1, 1, 'retired')],
      facts: [],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No rendered deliveries were served in the last 1 day.');
    expect(result.queries[1].calls).toContain('gte served_at 2026-10-11T12:00:00.000Z');
  });
});

describe('train', () => {
  const facts = syntheticFacts({ sessions: 60, perSession: 12, seed: 7 });
  const expected = trainFeedRanker(facts.map(feedRankerExampleFromFact), {
    values: DEFAULT_FEED_RANKER_ACTION_VALUES,
    liveWeights: effectiveFeedRankerWeights(LIVE_WEIGHTS),
  });
  const draftCreated = {
    create_feed_algorithm_version_draft: {
      data: { id: '00000000-0000-4000-8000-000000000005', algorithm_key: 'for-you-rules', version: 5 },
      error: null,
    },
  };

  it('prints the fit, the weights, the replay and the floor, and changes nothing without --apply', async () => {
    const result = await run(['train'], { facts });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Split by session (seed 20261012): train 48 sessions, 576 rows · holdout 12 sessions, 144 rows.');
    expect(result.stdout).toMatch(/meaningful\s+0\.\d{4}\s+0\.\d{4}\s+0\.\d{3}\s+\d+\/\d+\s+\d+ iterations/);
    expect(result.stdout).toContain('Coefficients: change in log-odds per standard deviation');
    expect(result.stdout).toContain(
      'Weights: 1·p(meaningful) − 0.5·p(quick skip) − 3·p(negative) at the top slot, linearised at the training means',
    );
    expect(result.stdout).toContain("so the positive weights sum to for-you-rules-v3's 1.12.");
    expect(result.stdout).toMatch(/semantic_similarity\s+0\s+0\s+never varied in the training rows: not learnable/);
    expect(result.stdout).toMatch(/interest_match\s+0\.24\s+\d/);
    expect(result.stdout).toContain('Replay of the 12 holdout sessions');
    expect(result.stdout).toMatch(/draft weights\s+144\s+\d+ \(/);
    expect(result.stdout).toContain('  rendered 720: ok');
    expect(result.stdout).toContain(`Draft weights JSON (for replay --weights):\n${JSON.stringify(expected.weights)}`);
    expect(result.stdout).toContain(
      'Dry run: nothing was changed. Re-run with --apply to call create_feed_algorithm_version_draft.',
    );
    expect(result.rpcCalls).toEqual([]);
  });

  it('writes the draft with the exact payload under --apply', async () => {
    const result = await run(['train', '--apply'], { facts, rpcResults: draftCreated });
    expect(result.exitCode).toBe(0);
    const auc = (action: string) => expected.fits.find((entry) => entry.action === action)!.holdoutAuc!.toFixed(3);
    expect(result.rpcCalls).toEqual([{
      name: 'create_feed_algorithm_version_draft',
      args: {
        p_algorithm_key: 'for-you-rules',
        p_description: `Fitted 2026-10-12: 720 rendered, AUC meaningful/skip/negative ${auc('meaningful')}/`
          + `${auc('quick_skip')}/${auc('negative')} (30-day window, values 1/-0.5/-3).`,
        p_weights: expected.weights,
        p_retrieval_config: LIVE_RETRIEVAL,
        p_diversity_config: LIVE_DIVERSITY,
      },
    }]);
    const args = result.rpcCalls[0].args as { p_description: string; p_weights: FeedRankerWeights };
    expect(args.p_description).toMatch(
      /^Fitted 2026-10-12: 720 rendered, AUC meaningful\/skip\/negative [01]\.\d{3}\/[01]\.\d{3}\/[01]\.\d{3} \(30-day window, values 1\/-0\.5\/-3\)\.$/,
    );
    expect(Object.keys(args.p_weights)).toEqual([...FEED_RANKER_WEIGHT_KEYS]);
    expect(result.stdout).toContain('Applied with create_feed_algorithm_version_draft:');
    expect(result.stdout).toContain(
      'promote it with npm run ops:feed-algorithm -- activate --key for-you-rules --version 5 --apply.',
    );
    expect(result.stdout).not.toContain('Dry run');
  });

  it('passes the chosen values into the fit and the description', async () => {
    const result = await run([
      'train', '--days', '14', '--value-meaningful', '2', '--value-negative', '0', '--apply',
    ], { facts, rpcResults: draftCreated });
    expect(result.exitCode).toBe(0);
    expect(result.queries[1].calls).toContain('gte served_at 2026-09-28T12:00:00.000Z');
    const args = result.rpcCalls[0].args as { p_description: string };
    expect(args.p_description).toContain('(14-day window, values 2/-0.5/0).');
    expect(result.stdout).toContain('Weights: 2·p(meaningful) − 0.5·p(quick skip) at the top slot');
    expect(result.stdout).toContain('  negative positives');
    expect(result.stdout).toContain(': not checked (value 0)');
  });

  it('refuses --apply below the sample floor, after printing everything', async () => {
    const small = syntheticFacts({ sessions: 10, perSession: 5, seed: 9 });
    const result = await run(['train', '--apply'], { facts: small, rpcResults: draftCreated });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Replay of the 2 holdout sessions');
    expect(result.stdout).toContain('  rendered 50: below the floor');
    expect(result.stdout).toContain('Draft weights JSON (for replay --weights):');
    expect(result.stderr).toMatch(/^Refusing --apply: below the sample floor \(rendered 50 < 500; meaningful positives \d+ < 50; /);
    expect(result.stderr).toContain('Re-run with --force to write the draft anyway.');
    expect(result.rpcCalls).toEqual([]);

    const dryRun = await run(['train'], { facts: small });
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain('Below the sample floor: --apply would be refused without --force.');
    const forcedDryRun = await run(['train', '--force'], { facts: small });
    expect(forcedDryRun.stdout).toContain('Below the sample floor: --apply --force would write the draft anyway.');
    expect(forcedDryRun.rpcCalls).toEqual([]);
  });

  it('writes below the floor with --force, and with the floor lowered', async () => {
    const small = syntheticFacts({ sessions: 10, perSession: 5, seed: 9 });
    const forced = await run(['train', '--apply', '--force'], { facts: small, rpcResults: draftCreated });
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain('Forced: writing the draft below the sample floor (rendered 50 < 500;');
    expect(forced.rpcCalls).toHaveLength(1);
    expect(forced.rpcCalls[0]).toMatchObject({
      name: 'create_feed_algorithm_version_draft',
      args: { p_algorithm_key: 'for-you-rules', p_retrieval_config: LIVE_RETRIEVAL, p_diversity_config: LIVE_DIVERSITY },
    });

    const lowered = await run(['train', '--apply', '--min-rendered', '50', '--min-positives', '1'], {
      facts: small,
      rpcResults: draftCreated,
    });
    expect(lowered.exitCode).toBe(0);
    expect(lowered.stdout).not.toContain('Forced');
    expect(lowered.rpcCalls).toHaveLength(1);
  });

  it('refuses without an active version, and with nothing rendered', async () => {
    const noActive = await run(['train'], { facts, versions: [versionRow(V1, 1, 'retired'), versionRow(V3, 3, 'shadow')] });
    expect(noActive.exitCode).toBe(1);
    expect(noActive.stderr).toContain('No for-you-rules version is active: there are no live weights to compare with.');
    expect(noActive.queries).toHaveLength(1);

    const empty = await run(['train', '--apply', '--force'], { facts: [] });
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain('Nothing to train on: no rendered deliveries in the window.');
    expect(empty.rpcCalls).toEqual([]);
  });

  it('exits 1 with the RPC error when the database refuses the draft', async () => {
    const result = await run(['train', '--apply'], {
      facts,
      rpcResults: {
        create_feed_algorithm_version_draft: {
          data: null,
          error: { message: 'Could not find the function public.create_feed_algorithm_version_draft', code: 'PGRST202' },
        },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('create_feed_algorithm_version_draft failed:');
    expect(result.stderr).toContain('is the feed ranking v4 migration applied?');
  });
});

describe('replay', () => {
  it('re-ranks the holdout sessions with the given weights and writes nothing', async () => {
    const facts = syntheticFacts({ sessions: 30, perSession: 16, seed: 4 });
    const result = await run(['replay', '--weights', '{"interest_match": 1, "quick_skip_risk": -1}'], { facts });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Weights: live is for-you-rules-v3; given is --weights, a missing key read as the feed reads it.');
    // Missing keys read as the normaliser's defaults, as the feed would.
    expect(result.stdout).toMatch(/interest_match\s+0\.24\s+1/);
    expect(result.stdout).toMatch(/freshness\s+0\.12\s+0\.15/);
    expect(result.stdout).toContain('Replay of the 6 holdout sessions');
    expect(result.stdout).toContain('6 of them have more than 12 items');
    expect(result.stdout).toMatch(/given weights\s+72\s+\d+ \(/);
    expect(result.stdout).toContain('Offline replay only: nothing was changed.');
    expect(result.rpcCalls).toEqual([]);

    const examples = facts.map(feedRankerExampleFromFact);
    const { holdout } = partitionFeedRankerExamples(examples);
    const replay = replayFeedRankerSessions(
      holdout,
      effectiveFeedRankerWeights(LIVE_WEIGHTS),
      effectiveFeedRankerWeights({ interest_match: 1, quick_skip_risk: -1 }),
    );
    expect(result.stdout).toMatch(new RegExp(`given weights\\s+72\\s+${replay.candidate.meaningful} \\(`));
    // Interest predicts meaningful engagement here: ranking by it lifts the top 12.
    expect(replay.candidate.meaningful).toBeGreaterThan(replay.logged.meaningful);
  });
});
