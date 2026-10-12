/**
 * For You ranker training: learn the value model's weights from the durable
 * delivery facts and write them as a draft algorithm version.
 *
 * `dataset` counts the training rows. `train` fits one L2-regularised logistic
 * regression per action (meaningful engagement, quick skip, negative feedback)
 * over the features each delivery was ranked with, scores the fits on a
 * holdout of whole sessions, replays those sessions offline and prints the
 * fitted `weights`; with `--apply` it writes them as a draft through
 * `create_feed_algorithm_version_draft` (plan
 * docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md §2.9 and §5).
 * `replay` re-ranks the same holdout sessions with weights given to it.
 *
 * Nothing here changes what viewers see: a draft serves nobody until it is
 * activated with `npm run ops:feed-algorithm -- activate`. Service role only;
 * nothing here prints the service-role key, the database URL or a viewer id.
 *
 * Runbook: docs/feed-algorithm-operations.md, "Training a version from data".
 */
import { pathToFileURL } from 'node:url';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { mulberry32 } from '../../src/lib/feed-thompson';
import { normalizeRankedFeedScoreWeights } from '../../src/lib/showcase-feed-ranking';

const DEFAULT_ALGORITHM_KEY = 'for-you-rules';
const MAX_ALGORITHM_KEY_LENGTH = 80;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 30;
const DEFAULT_MIN_RENDERED = 500;
const DEFAULT_MIN_POSITIVES = 50;
const MAX_SAMPLE_FLOOR = 10_000_000;
const MAX_ACTION_VALUE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Supabase's PostgREST `max_rows`: a larger page would come back cut to this. */
const FACT_PAGE_SIZE = 1000;
const MAX_DATASET_ROWS = 250_000;
const RUNBOOK_PATH = 'docs/feed-algorithm-operations.md';
const DRAFT_RPC = 'create_feed_algorithm_version_draft';
const DASH = '–';

/**
 * The keys of the versioned `weights` JSON, in the stored snake_case: the 12
 * keys `normalizeRankedFeedScoreWeights` reads before v4, plus v4's
 * `semantic_similarity`. Each is also a feature: a delivery's persisted
 * `score_components` hold the value it was ranked with under the same key.
 */
export const FEED_RANKER_WEIGHT_KEYS = [
  'interest_match',
  'creator_affinity',
  'smoothed_usefulness',
  'freshness',
  'relevant_trend',
  'exploration_bonus',
  'quick_skip_risk',
  'negative_feedback_risk',
  'engagement_depth',
  'attention_seconds_norm',
  'creator_quality',
  'exploration_ucb',
  'semantic_similarity',
] as const;

/**
 * `normalizeRankedFeedScoreWeights` reads every weight with
 * `finiteConfigNumber(value, default, -10, 10)`: a value outside falls back to
 * the v1 default, so the draft is clamped inside these bounds.
 */
export const FEED_RANKER_WEIGHT_BOUNDS = { min: -10, max: 10 } as const;

/** Features the model controls for that the weights JSON has no key for. */
export const FEED_RANKER_CONTROL_FEATURES = [
  'position',
  'is_following',
  'served_recently',
  'is_exploration',
] as const;

/** Every model feature, in the order of `FeedRankerExample.features`. */
export const FEED_RANKER_FEATURES: readonly string[] = [
  ...FEED_RANKER_WEIGHT_KEYS,
  ...FEED_RANKER_CONTROL_FEATURES,
];
const POSITION_FEATURE_INDEX = FEED_RANKER_WEIGHT_KEYS.length;

export const FEED_RANKER_ACTIONS = ['meaningful', 'quick_skip', 'negative'] as const;

export type FeedRankerAction = (typeof FEED_RANKER_ACTIONS)[number];
export type FeedRankerActionValues = Record<FeedRankerAction, number>;
export type FeedRankerWeightKey = (typeof FEED_RANKER_WEIGHT_KEYS)[number];
export type FeedRankerWeights = Record<FeedRankerWeightKey, number>;

/** Each action's value in the serve-time score (plan §5). */
export const DEFAULT_FEED_RANKER_ACTION_VALUES: FeedRankerActionValues = {
  meaningful: 1,
  quick_skip: -0.5,
  negative: -3,
};

const ACTION_LABELS: Record<FeedRankerAction, string> = {
  meaningful: 'meaningful',
  quick_skip: 'quick skip',
  negative: 'negative',
};

/** L2 penalty on the standardised coefficients (the intercept is not penalised). */
export const FEED_RANKER_L2 = 0.01;
export const FEED_RANKER_MAX_ITERATIONS = 3000;
/** Stop once no partial derivative of the mean loss exceeds this. */
export const FEED_RANKER_GRADIENT_TOLERANCE = 1e-7;
export const FEED_RANKER_SPLIT_SEED = 20_261_012;
export const FEED_RANKER_HOLDOUT_SHARE = 0.2;
export const FEED_RANKER_REPLAY_TOP_K = 12;
/**
 * The slot the serve-time score is read at (plan §5's `position = 1`, the top
 * slot). Stored positions are 0-based (`feed_delivery_facts.position >= 0`).
 */
export const FEED_RANKER_SERVE_POSITION = 0;
/** Decimal places kept in the draft weights. */
const WEIGHT_DECIMALS = 4;

/**
 * The `feed_delivery_facts` columns the trainer reads. The post's category
 * comes through the `post_id` foreign key: it decides which half of the
 * meaningful rule applies (video progress or still dwell).
 */
export const FEED_RANKER_FACT_COLUMNS = 'delivery_id, session_id, algorithm_version_id, position, '
  + 'is_exploration, exploration_propensity, score_components, dwell_ms_max, media_progress_max, '
  + 'saved_at, remix_started_at, resource_opened_at, purchased_at, commented_at, quick_skipped_at, '
  + 'not_interested_at, hid_creator_at, reported_at, posts(category)';

export const FEED_RANKER_USAGE = `
Magicbooklet For You ranker training (service role only)

Usage:
  npm run ops:feed-ranker -- dataset [--days 30] [--algorithm-key for-you-rules]
  npm run ops:feed-ranker -- train [--days 30] [--value-meaningful 1] [--value-skip -0.5] [--value-negative -3]
      [--min-rendered 500] [--min-positives 50] [--algorithm-key for-you-rules] [--apply] [--force]
  npm run ops:feed-ranker -- replay --weights '<json>' [--days 30] [--algorithm-key for-you-rules]

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY

Notes:
  - Reads the rendered feed_delivery_facts served in the last --days days (1-30). dataset and replay only
    read; train prints the fitted weights and changes nothing without --apply.
  - train --apply writes a draft version (create_feed_algorithm_version_draft) carrying the active version's
    retrieval and diversity settings. A draft serves nobody until ops:feed-algorithm activates it.
  - train refuses --apply below --min-rendered rendered rows, or below --min-positives positives for any
    action whose value is not 0, unless --force is given too.
  - --weights is a weights JSON object as stored on a version; a missing key reads as the feed reads it.
  - Runbook: ${RUNBOOK_PATH}
`.trim();

export type FeedRankerCommand =
  | { command: 'help' }
  | { command: 'dataset'; days: number; algorithmKey: string }
  | {
      command: 'train';
      days: number;
      algorithmKey: string;
      values: FeedRankerActionValues;
      minRendered: number;
      minPositives: number;
      apply: boolean;
      force: boolean;
    }
  | { command: 'replay'; days: number; algorithmKey: string; weights: Record<string, number> };

/** A malformed command line: printed with the usage, exit 1. */
export class FeedRankerUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedRankerUsageError';
  }
}

// ---------------------------------------------------------------------------
// Arguments

type Flags = Map<string, string | true>;

function parseFlags(
  tokens: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
): Flags {
  const flags: Flags = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new FeedRankerUsageError(`Unexpected argument: ${token}`);
    if (flags.has(token)) throw new FeedRankerUsageError(`Duplicate option: ${token}`);
    if (booleanFlags.includes(token)) {
      flags.set(token, true);
      continue;
    }
    // A mistyped option fails instead of being ignored: a mistyped
    // --min-positives would otherwise apply the default floor.
    if (!valueFlags.includes(token)) throw new FeedRankerUsageError(`Unknown option: ${token}`);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new FeedRankerUsageError(`Missing value for ${token}.`);
    }
    flags.set(token, value);
    index += 1;
  }
  return flags;
}

function requireText(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || !value.trim()) {
    throw new FeedRankerUsageError(`${name} is required.`);
  }
  return value.trim();
}

function optionalWholeNumber(flags: Flags, name: string, fallback: number, min: number, max: number) {
  if (!flags.has(name)) return fallback;
  const raw = requireText(flags, name);
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new FeedRankerUsageError(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function optionalDecimal(flags: Flags, name: string, fallback: number, min: number, max: number) {
  if (!flags.has(name)) return fallback;
  const raw = requireText(flags, name);
  const value = /^-?(\d+(\.\d+)?|\.\d+)$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new FeedRankerUsageError(`${name} must be a number from ${min} to ${max}.`);
  }
  // `-0` would print as "-0" in the draft's description.
  return value === 0 ? 0 : value;
}

function algorithmKeyFrom(flags: Flags): string {
  const key = flags.has('--algorithm-key') ? requireText(flags, '--algorithm-key') : DEFAULT_ALGORITHM_KEY;
  if (key.length > MAX_ALGORITHM_KEY_LENGTH) {
    throw new FeedRankerUsageError(`--algorithm-key must be at most ${MAX_ALGORITHM_KEY_LENGTH} characters.`);
  }
  return key;
}

function isWeightKey(key: string): key is FeedRankerWeightKey {
  return (FEED_RANKER_WEIGHT_KEYS as readonly string[]).includes(key);
}

/** `--weights`: a JSON object of known weight keys, each inside the normaliser's bounds. */
export function parseFeedRankerWeightsJson(raw: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FeedRankerUsageError('--weights must be a JSON object, for example {"interest_match": 0.2}.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FeedRankerUsageError('--weights must be a JSON object, for example {"interest_match": 0.2}.');
  }
  const weights: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    // An unknown key would be ignored by the feed: almost always a typo.
    if (!isWeightKey(key)) {
      throw new FeedRankerUsageError(
        `--weights has an unknown key: ${key}. The keys are ${FEED_RANKER_WEIGHT_KEYS.join(', ')}.`,
      );
    }
    if (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || value < FEED_RANKER_WEIGHT_BOUNDS.min
      || value > FEED_RANKER_WEIGHT_BOUNDS.max
    ) {
      throw new FeedRankerUsageError(
        `--weights ${key} must be a number from ${FEED_RANKER_WEIGHT_BOUNDS.min} to ${FEED_RANKER_WEIGHT_BOUNDS.max}.`,
      );
    }
    weights[key] = value;
  }
  return weights;
}

export function parseFeedRankerArgs(argv: readonly string[]): FeedRankerCommand {
  const [command, ...rest] = argv;
  if (command === undefined) throw new FeedRankerUsageError('Missing command.');
  if (command === 'help' || command === '--help' || rest.includes('--help')) {
    return { command: 'help' };
  }

  switch (command) {
    case 'dataset': {
      const flags = parseFlags(rest, ['--days', '--algorithm-key'], []);
      return {
        command: 'dataset',
        days: optionalWholeNumber(flags, '--days', DEFAULT_DAYS, 1, MAX_DAYS),
        algorithmKey: algorithmKeyFrom(flags),
      };
    }

    case 'train': {
      const flags = parseFlags(rest, [
        '--days',
        '--algorithm-key',
        '--value-meaningful',
        '--value-skip',
        '--value-negative',
        '--min-rendered',
        '--min-positives',
      ], ['--apply', '--force']);
      const values: FeedRankerActionValues = {
        meaningful: optionalDecimal(
          flags, '--value-meaningful', DEFAULT_FEED_RANKER_ACTION_VALUES.meaningful,
          -MAX_ACTION_VALUE, MAX_ACTION_VALUE,
        ),
        quick_skip: optionalDecimal(
          flags, '--value-skip', DEFAULT_FEED_RANKER_ACTION_VALUES.quick_skip,
          -MAX_ACTION_VALUE, MAX_ACTION_VALUE,
        ),
        negative: optionalDecimal(
          flags, '--value-negative', DEFAULT_FEED_RANKER_ACTION_VALUES.negative,
          -MAX_ACTION_VALUE, MAX_ACTION_VALUE,
        ),
      };
      if (FEED_RANKER_ACTIONS.every((action) => values[action] === 0)) {
        throw new FeedRankerUsageError('At least one of --value-meaningful, --value-skip and --value-negative must not be 0.');
      }
      return {
        command: 'train',
        days: optionalWholeNumber(flags, '--days', DEFAULT_DAYS, 1, MAX_DAYS),
        algorithmKey: algorithmKeyFrom(flags),
        values,
        minRendered: optionalWholeNumber(flags, '--min-rendered', DEFAULT_MIN_RENDERED, 0, MAX_SAMPLE_FLOOR),
        minPositives: optionalWholeNumber(flags, '--min-positives', DEFAULT_MIN_POSITIVES, 0, MAX_SAMPLE_FLOOR),
        apply: flags.get('--apply') === true,
        force: flags.get('--force') === true,
      };
    }

    case 'replay': {
      const flags = parseFlags(rest, ['--days', '--algorithm-key', '--weights'], []);
      return {
        command: 'replay',
        days: optionalWholeNumber(flags, '--days', DEFAULT_DAYS, 1, MAX_DAYS),
        algorithmKey: algorithmKeyFrom(flags),
        weights: parseFeedRankerWeightsJson(requireText(flags, '--weights')),
      };
    }

    default:
      throw new FeedRankerUsageError(`Unknown command: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// Rows, labels and features

type Row = Record<string, unknown>;

function asRow(value: unknown, source: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} returned a row that is not an object.`);
  }
  return value as Row;
}

/** PostgREST sends bigint as a JSON number; a numeric string is accepted too. */
function numberFrom(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function requiredString(row: Row, column: string, source: string): string {
  const value = row[column];
  if (typeof value !== 'string' || !value) throw new Error(`${source} returned a row without ${column}.`);
  return value;
}

function requiredWholeNumber(row: Row, column: string, source: string): number {
  const value = numberFrom(row[column]);
  if (value === null || !Number.isSafeInteger(value)) {
    throw new Error(`${source} returned a row without a whole ${column}.`);
  }
  return value;
}

function timestampFrom(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' && value ? value : null;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The inputs of `public.is_meaningful_feed_engagement`, v4 signature. */
export type FeedEngagementOutcome = {
  /** `posts.category`; null when the post row is missing. */
  category: string | null;
  mediaProgressMax: number | null;
  dwellMsMax: number | null;
  savedAt: string | null;
  remixStartedAt: string | null;
  resourceOpenedAt: string | null;
  purchasedAt: string | null;
  commentedAt: string | null;
};

/**
 * `public.is_meaningful_feed_engagement` in TypeScript
 * (`20260728181000_feed_ranking_v2.sql`, plus v4's `p_commented_at`): a video
 * played to half, or anything else held for 3 s, or a save, remix start,
 * resource open, purchase or comment. Only `'video'` is video, as in SQL; a
 * missing category takes the dwell rule (SQL coalesces it to '').
 */
export function isMeaningfulFeedEngagement(outcome: FeedEngagementOutcome): boolean {
  const isVideo = outcome.category === 'video';
  return (isVideo && (outcome.mediaProgressMax ?? 0) >= 0.5)
    || (!isVideo && (outcome.dwellMsMax ?? 0) >= 3000)
    || outcome.savedAt !== null
    || outcome.remixStartedAt !== null
    || outcome.resourceOpenedAt !== null
    || outcome.purchasedAt !== null
    || outcome.commentedAt !== null;
}

/**
 * A row's weight: the inverse of the probability the policy had of showing
 * it, when that is logged as a probability in (0, 1]. The ranking is
 * deterministic today and logs 1 (an exploration pick) or 0, so every row
 * weighs 1.
 */
export function feedRankerSampleWeight(explorationPropensity: number | null): number {
  return explorationPropensity !== null
    && Number.isFinite(explorationPropensity)
    && explorationPropensity > 0
    && explorationPropensity <= 1
    ? 1 / explorationPropensity
    : 1;
}

/**
 * The model's feature vector, in `FEED_RANKER_FEATURES` order: each weight key
 * from `score_components` clamped to [0, 1] as the scorer reads it (missing →
 * 0), then the raw 0-based position and the 0/1 flags.
 */
export function feedRankerFeatureVector(
  scoreComponents: Readonly<Record<string, unknown>>,
  position: number,
  isExploration: boolean,
): number[] {
  return [
    ...FEED_RANKER_WEIGHT_KEYS.map((key) => clampUnit(numberFrom(scoreComponents[key]) ?? 0)),
    position,
    scoreComponents.is_following === true ? 1 : 0,
    scoreComponents.served_recently === true ? 1 : 0,
    isExploration ? 1 : 0,
  ];
}

export type FeedRankerExample = {
  deliveryId: number;
  sessionId: string;
  algorithmVersionId: string;
  /** 0-based, as stored. */
  position: number;
  /** In `FEED_RANKER_FEATURES` order. */
  features: number[];
  labels: Record<FeedRankerAction, boolean>;
  explorationPropensity: number | null;
  sampleWeight: number;
  isExploration: boolean;
  /** The ranking stored `semantic_similarity` (v4 only). */
  hasSemanticSimilarity: boolean;
};

function categoryFrom(row: Row): string | null {
  // A to-one embed comes back as an object; tolerate a one-element array.
  const embedded = Array.isArray(row.posts) ? row.posts[0] : row.posts;
  if (embedded && typeof embedded === 'object') {
    const category = (embedded as Row).category;
    if (typeof category === 'string') return category;
  }
  return typeof row.category === 'string' ? row.category : null;
}

/** One `feed_delivery_facts` row (with its `posts(category)` embed) as a training example. */
export function feedRankerExampleFromFact(value: unknown): FeedRankerExample {
  const source = 'feed_delivery_facts';
  const row = asRow(value, source);
  const position = requiredWholeNumber(row, 'position', source);
  const rawComponents = row.score_components;
  const components: Row = rawComponents && typeof rawComponents === 'object' && !Array.isArray(rawComponents)
    ? rawComponents as Row
    : {};
  const isExploration = row.is_exploration === true;
  const explorationPropensity = numberFrom(row.exploration_propensity);
  return {
    deliveryId: requiredWholeNumber(row, 'delivery_id', source),
    sessionId: requiredString(row, 'session_id', source),
    algorithmVersionId: requiredString(row, 'algorithm_version_id', source),
    position,
    features: feedRankerFeatureVector(components, position, isExploration),
    labels: {
      meaningful: isMeaningfulFeedEngagement({
        category: categoryFrom(row),
        mediaProgressMax: numberFrom(row.media_progress_max),
        dwellMsMax: numberFrom(row.dwell_ms_max),
        savedAt: timestampFrom(row, 'saved_at'),
        remixStartedAt: timestampFrom(row, 'remix_started_at'),
        resourceOpenedAt: timestampFrom(row, 'resource_opened_at'),
        purchasedAt: timestampFrom(row, 'purchased_at'),
        commentedAt: timestampFrom(row, 'commented_at'),
      }),
      quick_skip: timestampFrom(row, 'quick_skipped_at') !== null,
      negative: timestampFrom(row, 'not_interested_at') !== null
        || timestampFrom(row, 'hid_creator_at') !== null
        || timestampFrom(row, 'reported_at') !== null,
    },
    explorationPropensity,
    sampleWeight: feedRankerSampleWeight(explorationPropensity),
    isExploration,
    hasSemanticSimilarity: numberFrom(components.semantic_similarity) !== null,
  };
}

// ---------------------------------------------------------------------------
// Dataset summary

export type FeedRankerCounts = {
  rows: number;
  sessions: number;
  positives: Record<FeedRankerAction, number>;
};

export type FeedRankerDatasetSummary = FeedRankerCounts & {
  explorationRows: number;
  semanticRows: number;
  /** Rows whose sample weight is not 1. */
  reweightedRows: number;
  maxSampleWeight: number;
  byVersion: Array<FeedRankerCounts & { algorithmVersionId: string }>;
};

function countExamples(examples: readonly FeedRankerExample[]): FeedRankerCounts {
  const positives: Record<FeedRankerAction, number> = { meaningful: 0, quick_skip: 0, negative: 0 };
  for (const example of examples) {
    for (const action of FEED_RANKER_ACTIONS) if (example.labels[action]) positives[action] += 1;
  }
  return {
    rows: examples.length,
    sessions: new Set(examples.map((example) => example.sessionId)).size,
    positives,
  };
}

export function summarizeFeedRankerDataset(examples: readonly FeedRankerExample[]): FeedRankerDatasetSummary {
  const byVersion = new Map<string, FeedRankerExample[]>();
  for (const example of examples) {
    const rows = byVersion.get(example.algorithmVersionId);
    if (rows) rows.push(example);
    else byVersion.set(example.algorithmVersionId, [example]);
  }
  const reweighted = examples.filter((example) => example.sampleWeight !== 1);
  return {
    ...countExamples(examples),
    explorationRows: examples.filter((example) => example.isExploration).length,
    semanticRows: examples.filter((example) => example.hasSemanticSimilarity).length,
    reweightedRows: reweighted.length,
    maxSampleWeight: Math.max(1, ...reweighted.map((example) => example.sampleWeight)),
    byVersion: [...byVersion].map(([algorithmVersionId, rows]) => ({
      algorithmVersionId,
      ...countExamples(rows),
    })),
  };
}

// ---------------------------------------------------------------------------
// Holdout split

/**
 * The holdout sessions: a seeded shuffle of the distinct session ids (sorted
 * first, so the row order never matters), of which the first
 * `share` (at least one, never all) are held out. Splitting by session keeps a
 * session's rows together: rows from one feed session share a viewer and a
 * moment, so splitting them would leak the holdout into training.
 */
export function splitSessionsForHoldout(
  sessionIds: Iterable<string>,
  seed: number = FEED_RANKER_SPLIT_SEED,
  share: number = FEED_RANKER_HOLDOUT_SHARE,
): Set<string> {
  const sessions = [...new Set(sessionIds)].sort();
  if (sessions.length < 2) return new Set();
  const random = mulberry32(seed);
  for (let index = sessions.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [sessions[index], sessions[swap]] = [sessions[swap], sessions[index]];
  }
  const holdoutCount = Math.min(sessions.length - 1, Math.max(1, Math.round(sessions.length * share)));
  return new Set(sessions.slice(0, holdoutCount));
}

export function partitionFeedRankerExamples(
  examples: readonly FeedRankerExample[],
  seed: number = FEED_RANKER_SPLIT_SEED,
): { train: FeedRankerExample[]; holdout: FeedRankerExample[]; holdoutSessions: Set<string> } {
  const holdoutSessions = splitSessionsForHoldout(examples.map((example) => example.sessionId), seed);
  return {
    train: examples.filter((example) => !holdoutSessions.has(example.sessionId)),
    holdout: examples.filter((example) => holdoutSessions.has(example.sessionId)),
    holdoutSessions,
  };
}

// ---------------------------------------------------------------------------
// Logistic regression

export type LogisticRegressionOptions = {
  l2?: number;
  maxIterations?: number;
  tolerance?: number;
};

export type LogisticRegressionModel = {
  intercept: number;
  /** Change in log-odds per standard deviation of each feature; 0 for a feature that never varied. */
  standardizedCoefficients: number[];
  /** Change in log-odds per unit of each feature (standardised coefficient ÷ scale). */
  coefficients: number[];
  /** Weighted training mean and standard deviation of each feature; scale 0 = never varied. */
  means: number[];
  scales: number[];
  iterations: number;
  converged: boolean;
};

function sigmoid(logit: number): number {
  if (logit >= 0) return 1 / (1 + Math.exp(-logit));
  const exp = Math.exp(logit);
  return exp / (1 + exp);
}

function logit(probability: number): number {
  return Math.log(probability / (1 - probability));
}

/**
 * Weighted mean and standard deviation of each column. A deviation below
 * 1e-9 reads as 0: the column is constant up to rounding and carries nothing.
 */
export function weightedFeatureMoments(
  features: readonly (readonly number[])[],
  weights: readonly number[],
): { means: number[]; scales: number[] } {
  const width = features[0]?.length ?? 0;
  const means = new Array<number>(width).fill(0);
  const scales = new Array<number>(width).fill(0);
  let total = 0;
  for (let row = 0; row < features.length; row += 1) {
    if (features[row].length !== width) throw new Error('Every feature row must have the same width.');
    total += weights[row];
    for (let column = 0; column < width; column += 1) means[column] += weights[row] * features[row][column];
  }
  if (!(total > 0)) return { means, scales };
  for (let column = 0; column < width; column += 1) means[column] /= total;
  for (let row = 0; row < features.length; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const deviation = features[row][column] - means[column];
      scales[column] += weights[row] * deviation * deviation;
    }
  }
  for (let column = 0; column < width; column += 1) {
    const scale = Math.sqrt(scales[column] / total);
    scales[column] = scale > 1e-9 ? scale : 0;
  }
  return { means, scales };
}

/**
 * Weighted logistic regression with an L2 penalty on the standardised
 * coefficients, by full-batch gradient descent (Nesterov momentum with
 * gradient restarts, step 1/L for the loss's Lipschitz bound). Minimises
 * Σ wᵢ·logloss(yᵢ, σ(b + β·zᵢ)) / Σ wᵢ + (λ/2)·‖β‖², with z the features
 * standardised on the training rows.
 */
export function fitLogisticRegression(
  features: readonly (readonly number[])[],
  labels: readonly boolean[],
  weights: readonly number[],
  options: LogisticRegressionOptions = {},
): LogisticRegressionModel {
  const rowCount = features.length;
  if (rowCount === 0 || labels.length !== rowCount || weights.length !== rowCount) {
    throw new Error('Logistic regression needs one label and one weight per feature row.');
  }
  const width = features[0].length;
  const l2 = options.l2 ?? FEED_RANKER_L2;
  const maxIterations = options.maxIterations ?? FEED_RANKER_MAX_ITERATIONS;
  const tolerance = options.tolerance ?? FEED_RANKER_GRADIENT_TOLERANCE;

  let totalWeight = 0;
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) throw new Error('Sample weights must be finite and non-negative.');
    totalWeight += weight;
  }
  if (!(totalWeight > 0)) throw new Error('Logistic regression needs a positive total sample weight.');
  const { means, scales } = weightedFeatureMoments(features, weights);

  const standardized = new Float64Array(rowCount * width);
  const outcomes = new Float64Array(rowCount);
  const shares = new Float64Array(rowCount);
  let positiveShare = 0;
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < width; column += 1) {
      standardized[row * width + column] = scales[column] > 0
        ? (features[row][column] - means[column]) / scales[column]
        : 0;
    }
    outcomes[row] = labels[row] ? 1 : 0;
    shares[row] = weights[row] / totalWeight;
    positiveShare += shares[row] * outcomes[row];
  }

  const dimension = width + 1;
  const activeFeatures = scales.filter((scale) => scale > 0).length;
  // The Hessian of the mean loss is at most ¼·Zᵀdiag(w)Z + λI, whose largest
  // eigenvalue is at most ¼·(trace) + λ = ¼·(1 + active features) + λ.
  const step = 1 / (0.25 * (1 + activeFeatures) + l2);

  const gradientAt = (point: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let row = 0; row < rowCount; row += 1) {
      const offset = row * width;
      let logOdds = point[0];
      for (let column = 0; column < width; column += 1) logOdds += point[column + 1] * standardized[offset + column];
      const residual = shares[row] * (sigmoid(logOdds) - outcomes[row]);
      out[0] += residual;
      for (let column = 0; column < width; column += 1) out[column + 1] += residual * standardized[offset + column];
    }
    for (let index = 1; index < dimension; index += 1) out[index] += l2 * point[index];
  };

  const theta = new Float64Array(dimension);
  theta[0] = logit(Math.min(1 - 1e-6, Math.max(1e-6, positiveShare)));
  const previous = Float64Array.from(theta);
  const lookahead = new Float64Array(dimension);
  const gradient = new Float64Array(dimension);
  const next = new Float64Array(dimension);
  let sinceRestart = 0;
  let iterations = 0;
  let converged = false;
  while (iterations < maxIterations) {
    const momentum = sinceRestart / (sinceRestart + 3);
    for (let index = 0; index < dimension; index += 1) {
      lookahead[index] = theta[index] + momentum * (theta[index] - previous[index]);
    }
    gradientAt(lookahead, gradient);
    iterations += 1;
    let largest = 0;
    for (let index = 0; index < dimension; index += 1) largest = Math.max(largest, Math.abs(gradient[index]));
    if (largest < tolerance) {
      theta.set(lookahead);
      converged = true;
      break;
    }
    let alignment = 0;
    for (let index = 0; index < dimension; index += 1) {
      next[index] = lookahead[index] - step * gradient[index];
      alignment += gradient[index] * (next[index] - theta[index]);
    }
    previous.set(theta);
    theta.set(next);
    // The step went uphill against the momentum: drop the momentum.
    sinceRestart = alignment > 0 ? 0 : sinceRestart + 1;
  }

  const standardizedCoefficients = Array.from(theta.subarray(1));
  return {
    intercept: theta[0],
    standardizedCoefficients,
    coefficients: standardizedCoefficients.map((coefficient, column) => (
      scales[column] > 0 ? coefficient / scales[column] : 0
    )),
    means,
    scales,
    iterations,
    converged,
  };
}

export function predictLogisticProbability(model: LogisticRegressionModel, features: readonly number[]): number {
  let logOdds = model.intercept;
  for (let column = 0; column < model.means.length; column += 1) {
    if (model.scales[column] > 0) {
      logOdds += model.standardizedCoefficients[column] * (features[column] - model.means[column]) / model.scales[column];
    }
  }
  return sigmoid(logOdds);
}

const PROBABILITY_FLOOR = 1e-12;

/** Mean weighted log-loss; null without weight. */
export function weightedLogLoss(
  probabilities: readonly number[],
  labels: readonly boolean[],
  weights: readonly number[],
): number | null {
  let loss = 0;
  let total = 0;
  for (let index = 0; index < probabilities.length; index += 1) {
    const probability = Math.min(1 - PROBABILITY_FLOOR, Math.max(PROBABILITY_FLOOR, probabilities[index]));
    loss -= weights[index] * Math.log(labels[index] ? probability : 1 - probability);
    total += weights[index];
  }
  return total > 0 ? loss / total : null;
}

/**
 * Weighted ROC AUC: the chance a positive outscores a negative, a tie counting
 * half. Null without both a positive and a negative.
 */
export function weightedAuc(
  scores: readonly number[],
  labels: readonly boolean[],
  weights: readonly number[],
): number | null {
  let positiveTotal = 0;
  let negativeTotal = 0;
  for (let index = 0; index < scores.length; index += 1) {
    if (labels[index]) positiveTotal += weights[index];
    else negativeTotal += weights[index];
  }
  if (!(positiveTotal > 0) || !(negativeTotal > 0)) return null;
  const order = scores.map((_, index) => index).sort((left, right) => scores[left] - scores[right]);
  let negativesBelow = 0;
  let area = 0;
  for (let start = 0; start < order.length;) {
    let end = start;
    let positives = 0;
    let negatives = 0;
    while (end < order.length && scores[order[end]] === scores[order[start]]) {
      if (labels[order[end]]) positives += weights[order[end]];
      else negatives += weights[order[end]];
      end += 1;
    }
    area += positives * (negativesBelow + negatives / 2);
    negativesBelow += negatives;
    start = end;
  }
  return area / (positiveTotal * negativeTotal);
}

// ---------------------------------------------------------------------------
// Weights

function camelCaseKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function snakeCaseKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * The weights the feed ranks with for a stored `weights` JSON: what
 * `normalizeRankedFeedScoreWeights` makes of each key (a missing or
 * out-of-bounds value takes its default), and 0 for a key it does not read
 * yet, since the feed then ignores it.
 */
export function effectiveFeedRankerWeights(
  stored: Readonly<Record<string, unknown>> | null | undefined,
): FeedRankerWeights {
  const normalized = normalizeRankedFeedScoreWeights(stored ? { ...stored } : {}) as unknown as Record<string, number>;
  const weights = {} as FeedRankerWeights;
  for (const key of FEED_RANKER_WEIGHT_KEYS) {
    const value = normalized[camelCaseKey(key)];
    weights[key] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  return weights;
}

/**
 * Problems that would make the feed read `weights` differently from what was
 * fitted: a key the ranking reads that the trainer does not emit (it would
 * take its v1 default), or a value the normaliser would replace. Empty = the
 * weights pass the normaliser unchanged.
 */
export function feedRankerWeightsNormalizerMismatches(weights: Readonly<Record<string, number>>): string[] {
  const normalized = normalizeRankedFeedScoreWeights({ ...weights }) as unknown as Record<string, number>;
  const problems: string[] = [];
  for (const camelKey of Object.keys(normalized)) {
    const key = snakeCaseKey(camelKey);
    if (!(key in weights)) {
      problems.push(`${key} is read by the feed but not fitted`);
    } else if (normalized[camelKey] !== weights[key]) {
      problems.push(`${key} ${weights[key]} reads as ${normalized[camelKey]}`);
    }
  }
  return problems;
}

function roundWeight(value: number): number {
  const factor = 10 ** WEIGHT_DECIMALS;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

export type FeedRankerRescale = {
  livePositiveSum: number;
  fittedPositiveSum: number;
  /** Null when either sum is 0: the fitted weights are then kept unscaled. */
  factor: number | null;
};

/**
 * Rescales the linearised weights so their positive weights sum to the live
 * row's positive sum, then clamps each into the normaliser's bounds and rounds
 * it. The fit fixes the weights' ratios, not their scale, and the scale is not
 * free: `offsetRankedFeedScore` adds a fixed 0.001 to every positive score.
 * Every key is emitted, so none can fall back to a v1 default.
 */
export function finalizeFeedRankerWeights(
  linearized: Readonly<FeedRankerWeights>,
  liveWeights: Readonly<FeedRankerWeights>,
): { weights: FeedRankerWeights; rescale: FeedRankerRescale; clampedKeys: FeedRankerWeightKey[] } {
  const positiveSum = (weights: Readonly<FeedRankerWeights>) => FEED_RANKER_WEIGHT_KEYS
    .reduce((sum, key) => sum + Math.max(0, weights[key]), 0);
  const livePositiveSum = positiveSum(liveWeights);
  const fittedPositiveSum = positiveSum(linearized);
  const factor = livePositiveSum > 0 && fittedPositiveSum > 0 ? livePositiveSum / fittedPositiveSum : null;
  const weights = {} as FeedRankerWeights;
  const clampedKeys: FeedRankerWeightKey[] = [];
  for (const key of FEED_RANKER_WEIGHT_KEYS) {
    const scaled = linearized[key] * (factor ?? 1);
    const clamped = Math.min(FEED_RANKER_WEIGHT_BOUNDS.max, Math.max(FEED_RANKER_WEIGHT_BOUNDS.min, scaled));
    if (clamped !== scaled) clampedKeys.push(key);
    weights[key] = roundWeight(clamped);
  }
  return { weights, rescale: { livePositiveSum, fittedPositiveSum, factor }, clampedKeys };
}

// ---------------------------------------------------------------------------
// Replay

export type FeedRankerReplayArm = {
  items: number;
  meaningful: number;
  quickSkips: number;
};

export type FeedRankerReplay = {
  topK: number;
  sessions: number;
  /** Sessions with more rendered items than `topK`: the only ones whose top can change. */
  sessionsAboveTopK: number;
  /** In the order the items were served (logged position). */
  logged: FeedRankerReplayArm;
  live: FeedRankerReplayArm;
  candidate: FeedRankerReplayArm;
};

/** The base score: Σ weight × feature over the stored (clamped) features. */
export function feedRankerBaseScore(example: FeedRankerExample, weights: Readonly<FeedRankerWeights>): number {
  let score = 0;
  FEED_RANKER_WEIGHT_KEYS.forEach((key, index) => {
    score += weights[key] * example.features[index];
  });
  return score;
}

/**
 * Re-ranks each session's rendered items by the live and by the candidate
 * weights (base score only: no diversity rules, multipliers or cold-start
 * slot), ties by served position, and counts the outcomes in each top `topK`.
 */
export function replayFeedRankerSessions(
  examples: readonly FeedRankerExample[],
  liveWeights: Readonly<FeedRankerWeights>,
  candidateWeights: Readonly<FeedRankerWeights>,
  topK: number = FEED_RANKER_REPLAY_TOP_K,
): FeedRankerReplay {
  const sessions = new Map<string, FeedRankerExample[]>();
  for (const example of examples) {
    const items = sessions.get(example.sessionId);
    if (items) items.push(example);
    else sessions.set(example.sessionId, [example]);
  }
  const empty = (): FeedRankerReplayArm => ({ items: 0, meaningful: 0, quickSkips: 0 });
  const replay: FeedRankerReplay = {
    topK,
    sessions: sessions.size,
    sessionsAboveTopK: 0,
    logged: empty(),
    live: empty(),
    candidate: empty(),
  };
  const tally = (arm: FeedRankerReplayArm, ranked: readonly FeedRankerExample[]) => {
    for (const example of ranked.slice(0, topK)) {
      arm.items += 1;
      if (example.labels.meaningful) arm.meaningful += 1;
      if (example.labels.quick_skip) arm.quickSkips += 1;
    }
  };
  const byServedOrder = (left: FeedRankerExample, right: FeedRankerExample) => (
    left.position - right.position || left.deliveryId - right.deliveryId
  );
  const rankBy = (items: readonly FeedRankerExample[], weights: Readonly<FeedRankerWeights>) => items
    .map((example) => ({ example, score: feedRankerBaseScore(example, weights) }))
    .sort((left, right) => right.score - left.score || byServedOrder(left.example, right.example))
    .map(({ example }) => example);

  for (const items of sessions.values()) {
    if (items.length > topK) replay.sessionsAboveTopK += 1;
    tally(replay.logged, [...items].sort(byServedOrder));
    tally(replay.live, rankBy(items, liveWeights));
    tally(replay.candidate, rankBy(items, candidateWeights));
  }
  return replay;
}

// ---------------------------------------------------------------------------
// Training

export type FeedRankerActionFit = {
  action: FeedRankerAction;
  value: number;
  trainPositives: number;
  holdoutPositives: number;
  /** Null when the training rows lack a positive or a negative example. */
  model: LogisticRegressionModel | null;
  /** Weighted positive rate of the training rows: the constant-rate baseline. */
  baselineRate: number;
  /** p̂ at the linearisation point (training means, top slot). */
  probabilityAtServe: number;
  holdoutLogLoss: number | null;
  baselineLogLoss: number | null;
  holdoutAuc: number | null;
};

export type FeedRankerTrainingResult = {
  trainRows: number;
  holdoutRows: number;
  trainSessions: number;
  holdoutSessions: number;
  fits: FeedRankerActionFit[];
  /** Where the value model is linearised: training means, position at the top slot. */
  evaluationPoint: number[];
  /** `w_k = Σ_a value_a · coef_{a,k} · p̂_a(1 − p̂_a)`, before rescaling. */
  linearizedWeights: FeedRankerWeights;
  /** The draft: rescaled, clamped, rounded. */
  weights: FeedRankerWeights;
  /** The live version's weights as the feed reads them: the rescale target and the replay's baseline. */
  liveWeights: FeedRankerWeights;
  rescale: FeedRankerRescale;
  clampedKeys: FeedRankerWeightKey[];
  /** Weight keys that never varied in the training rows: not learnable, so 0. */
  unvariedKeys: FeedRankerWeightKey[];
  replay: FeedRankerReplay;
};

export type FeedRankerTrainingOptions = {
  values: FeedRankerActionValues;
  liveWeights: FeedRankerWeights;
  seed?: number;
  regression?: LogisticRegressionOptions;
};

/**
 * Fits the value model on the training sessions, evaluates it on the holdout
 * sessions and maps it to the versioned weights:
 * serve-time value = Σ_a value_a · p̂_a(x, position = top slot), linearised at
 * the training means as w_k = Σ_a value_a · coef_{a,k} · p̂_a(1 − p̂_a).
 */
export function trainFeedRanker(
  examples: readonly FeedRankerExample[],
  options: FeedRankerTrainingOptions,
): FeedRankerTrainingResult {
  const { train, holdout, holdoutSessions } = partitionFeedRankerExamples(examples, options.seed);
  if (train.length === 0) throw new Error('Nothing to train on: no rendered deliveries in the window.');

  const trainFeatures = train.map((example) => example.features);
  const trainWeights = train.map((example) => example.sampleWeight);
  const holdoutWeights = holdout.map((example) => example.sampleWeight);
  const trainWeightTotal = trainWeights.reduce((sum, weight) => sum + weight, 0);
  // Every action is fitted on these rows, so these are every model's moments.
  const moments = weightedFeatureMoments(trainFeatures, trainWeights);
  const evaluationPoint = [...moments.means];
  evaluationPoint[POSITION_FEATURE_INDEX] = FEED_RANKER_SERVE_POSITION;
  const unvariedKeys = FEED_RANKER_WEIGHT_KEYS.filter((_, index) => moments.scales[index] === 0);

  const fits = FEED_RANKER_ACTIONS.map((action): FeedRankerActionFit => {
    const trainLabels = train.map((example) => example.labels[action]);
    const holdoutLabels = holdout.map((example) => example.labels[action]);
    const positiveWeight = train.reduce((sum, example) => sum + (example.labels[action] ? example.sampleWeight : 0), 0);
    const baselineRate = positiveWeight / trainWeightTotal;
    const fit: FeedRankerActionFit = {
      action,
      value: options.values[action],
      trainPositives: trainLabels.filter(Boolean).length,
      holdoutPositives: holdoutLabels.filter(Boolean).length,
      model: null,
      baselineRate,
      probabilityAtServe: baselineRate,
      holdoutLogLoss: null,
      baselineLogLoss: holdout.length > 0
        ? weightedLogLoss(holdout.map(() => baselineRate), holdoutLabels, holdoutWeights)
        : null,
      holdoutAuc: null,
    };
    // Without both outcomes the regression has nothing to separate.
    if (positiveWeight <= 0 || positiveWeight >= trainWeightTotal) return fit;

    const model = fitLogisticRegression(trainFeatures, trainLabels, trainWeights, options.regression);
    const holdoutScores = holdout.map((example) => predictLogisticProbability(model, example.features));
    return {
      ...fit,
      model,
      probabilityAtServe: predictLogisticProbability(model, evaluationPoint),
      holdoutLogLoss: holdout.length > 0 ? weightedLogLoss(holdoutScores, holdoutLabels, holdoutWeights) : null,
      holdoutAuc: weightedAuc(holdoutScores, holdoutLabels, holdoutWeights),
    };
  });

  const linearizedWeights = {} as FeedRankerWeights;
  FEED_RANKER_WEIGHT_KEYS.forEach((key, index) => {
    let weight = 0;
    for (const fit of fits) {
      if (!fit.model) continue;
      const slope = fit.probabilityAtServe * (1 - fit.probabilityAtServe);
      weight += fit.value * fit.model.coefficients[index] * slope;
    }
    linearizedWeights[key] = weight;
  });
  const finalized = finalizeFeedRankerWeights(linearizedWeights, options.liveWeights);

  return {
    trainRows: train.length,
    holdoutRows: holdout.length,
    trainSessions: new Set(train.map((example) => example.sessionId)).size,
    holdoutSessions: holdoutSessions.size,
    fits,
    evaluationPoint,
    linearizedWeights,
    weights: finalized.weights,
    liveWeights: options.liveWeights,
    rescale: finalized.rescale,
    clampedKeys: finalized.clampedKeys,
    unvariedKeys,
    replay: replayFeedRankerSessions(holdout, options.liveWeights, finalized.weights),
  };
}

// ---------------------------------------------------------------------------
// Sample floor and the draft

export type FeedRankerFloorCheck = {
  passed: boolean;
  failures: string[];
  lines: string[];
};

/**
 * `--min-rendered` applies to the rendered rows; `--min-positives` to each
 * action whose value is not 0 (an action valued 0 adds nothing to the weights).
 */
export function checkFeedRankerSampleFloor(
  summary: FeedRankerCounts,
  floor: { minRendered: number; minPositives: number; values: FeedRankerActionValues },
): FeedRankerFloorCheck {
  const failures: string[] = [];
  const lines = [`Sample floor (--min-rendered ${floor.minRendered}, --min-positives ${floor.minPositives}):`];
  const renderedOk = summary.rows >= floor.minRendered;
  lines.push(`  rendered ${summary.rows}: ${renderedOk ? 'ok' : 'below the floor'}`);
  if (!renderedOk) failures.push(`rendered ${summary.rows} < ${floor.minRendered}`);
  for (const action of FEED_RANKER_ACTIONS) {
    const positives = summary.positives[action];
    if (floor.values[action] === 0) {
      lines.push(`  ${ACTION_LABELS[action]} positives ${positives}: not checked (value 0)`);
      continue;
    }
    const ok = positives >= floor.minPositives;
    lines.push(`  ${ACTION_LABELS[action]} positives ${positives}: ${ok ? 'ok' : 'below the floor'}`);
    if (!ok) failures.push(`${ACTION_LABELS[action]} positives ${positives} < ${floor.minPositives}`);
  }
  return { passed: failures.length === 0, failures, lines };
}

function formatAuc(value: number | null): string {
  return value === null ? DASH : value.toFixed(3);
}

export function feedRankerDraftDescription(input: {
  now: Date;
  rendered: number;
  days: number;
  values: FeedRankerActionValues;
  fits: readonly FeedRankerActionFit[];
}): string {
  const auc = (action: FeedRankerAction) => formatAuc(
    input.fits.find((fit) => fit.action === action)?.holdoutAuc ?? null,
  );
  const { meaningful, quick_skip: quickSkip, negative } = input.values;
  return `Fitted ${input.now.toISOString().slice(0, 10)}: ${input.rendered} rendered, `
    + `AUC meaningful/skip/negative ${auc('meaningful')}/${auc('quick_skip')}/${auc('negative')} `
    + `(${input.days}-day window, values ${meaningful}/${quickSkip}/${negative}).`;
}

export type CreateFeedAlgorithmVersionDraftPayload = {
  p_algorithm_key: string;
  p_description: string;
  p_weights: FeedRankerWeights;
  p_retrieval_config: Record<string, unknown>;
  p_diversity_config: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Database

export type FeedRankerVersion = {
  id: string;
  algorithmKey: string;
  version: number;
  status: string;
  weights: Record<string, unknown>;
  retrievalConfig: Record<string, unknown>;
  diversityConfig: Record<string, unknown>;
};

type DatabaseError = { message?: string; code?: string };

function describeError(error: DatabaseError): string {
  const message = error.message || 'unknown error';
  // PGRST202: no such function; 42703: no such column (commented_at is v4's).
  if (error.code === 'PGRST202' || error.code === '42703') {
    return `${message} (${error.code}; is the feed ranking v4 migration applied?)`;
  }
  return error.code ? `${message} (${error.code})` : message;
}

function jsonObject(row: Row, column: string, source: string): Record<string, unknown> {
  const value = row[column];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} returned a row whose ${column} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeVersion(value: unknown): FeedRankerVersion {
  const source = 'feed_algorithm_versions';
  const row = asRow(value, source);
  return {
    id: requiredString(row, 'id', source),
    algorithmKey: requiredString(row, 'algorithm_key', source),
    version: requiredWholeNumber(row, 'version', source),
    status: requiredString(row, 'status', source),
    weights: jsonObject(row, 'weights', source),
    retrievalConfig: jsonObject(row, 'retrieval_config', source),
    diversityConfig: jsonObject(row, 'diversity_config', source),
  };
}

async function loadVersions(client: SupabaseClient, algorithmKey: string): Promise<FeedRankerVersion[]> {
  const { data, error } = await client
    .from('feed_algorithm_versions')
    .select('id, algorithm_key, version, status, weights, retrieval_config, diversity_config')
    .eq('algorithm_key', algorithmKey)
    .order('version', { ascending: true });
  if (error) throw new Error(`Reading feed_algorithm_versions failed: ${describeError(error)}`);
  const rows: unknown[] = data ?? [];
  return rows.map((row) => normalizeVersion(row));
}

/**
 * The rendered facts of the given versions served since `since`, paged by
 * `delivery_id` until a page comes back empty (so a server row cap smaller
 * than the page cannot end the read early).
 */
export async function loadFeedRankerExamples(
  client: SupabaseClient,
  input: { versionIds: readonly string[]; since: string },
): Promise<FeedRankerExample[]> {
  const examples: FeedRankerExample[] = [];
  let cursor: number | null = null;
  for (;;) {
    let query = client
      .from('feed_delivery_facts')
      .select(FEED_RANKER_FACT_COLUMNS)
      .in('algorithm_version_id', [...input.versionIds])
      .gte('served_at', input.since)
      .not('rendered_at', 'is', null);
    if (cursor !== null) query = query.gt('delivery_id', cursor);
    const { data, error } = await query.order('delivery_id', { ascending: true }).limit(FACT_PAGE_SIZE);
    if (error) throw new Error(`Reading feed_delivery_facts failed: ${describeError(error)}`);
    const rows: unknown[] = data ?? [];
    if (rows.length === 0) return examples;
    for (const row of rows) examples.push(feedRankerExampleFromFact(row));
    if (examples.length > MAX_DATASET_ROWS) {
      throw new Error(
        `More than ${MAX_DATASET_ROWS} rendered deliveries in the window: run with fewer --days.`,
      );
    }
    const last = examples[examples.length - 1].deliveryId;
    if (cursor !== null && last <= cursor) throw new Error('feed_delivery_facts paging did not advance.');
    cursor = last;
  }
}

// ---------------------------------------------------------------------------
// Formatting

function alignColumns(
  rows: readonly (readonly string[])[],
  align: readonly ('left' | 'right')[] = [],
): string[] {
  if (rows.length === 0) return [];
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) => (
    Math.max(...rows.map((row) => (row[column] ?? '').length))
  ));
  return rows.map((row) => row
    .map((cell, column) => (
      align[column] === 'right' ? cell.padStart(widths[column]) : cell.padEnd(widths[column])
    ))
    .join('  ')
    .trimEnd());
}

function formatShare(count: number, total: number): string {
  return total > 0 ? `${count} (${((count / total) * 100).toFixed(1)}%)` : String(count);
}

function formatNumber(value: number | null, digits: number): string {
  return value === null ? DASH : value.toFixed(digits);
}

/** A weight as stored: at most 4 decimals, no trailing zeros. */
function formatWeight(value: number): string {
  return String(roundWeight(value));
}

function period(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

function versionLabel(version: { algorithmKey: string; version: number }): string {
  return `${version.algorithmKey}-v${version.version}`;
}

function sampleWeightLine(summary: FeedRankerDatasetSummary): string {
  if (summary.reweightedRows === 0) {
    return '  Sample weights: every row weighs 1. A row weighs 1 / exploration_propensity when that is in (0, 1], '
      + 'and the ranking is deterministic: it logs 1 for an exploration pick and 0 for everything else.';
  }
  return `  Sample weights: ${summary.reweightedRows} rows weigh 1 / exploration_propensity `
    + `(largest ${summary.maxSampleWeight.toFixed(2)}); the rest weigh 1.`;
}

export function formatFeedRankerDataset(
  summary: FeedRankerDatasetSummary,
  context: { days: number; algorithmKey: string; versions: readonly FeedRankerVersion[] },
): string[] {
  const lines = [
    `Feed ranker dataset: rendered ${context.algorithmKey} deliveries served in the last ${period(context.days)} `
      + '(feed_delivery_facts).',
  ];
  if (summary.rows === 0) {
    lines.push(`  No rendered deliveries were served in the last ${period(context.days)}.`);
    return lines;
  }
  lines.push(
    `  rendered ${summary.rows} · sessions ${summary.sessions} · exploration picks ${summary.explorationRows}`,
    `  positives: ${FEED_RANKER_ACTIONS
      .map((action) => `${ACTION_LABELS[action]} ${formatShare(summary.positives[action], summary.rows)}`)
      .join(' · ')}`,
    `  semantic_similarity is stored on ${summary.semanticRows} of ${summary.rows} rows `
      + '(v4 rankings store it; a missing feature reads as 0).',
    sampleWeightLine(summary),
    '',
  );
  const labels = new Map(context.versions.map((version) => [version.id, versionLabel(version)]));
  lines.push(...alignColumns([
    ['  VERSION', 'RENDERED', 'SESSIONS', 'MEANINGFUL', 'QUICK SKIP', 'NEGATIVE'],
    ...summary.byVersion.map((entry) => [
      `  ${labels.get(entry.algorithmVersionId) ?? `version ${entry.algorithmVersionId}`}`,
      String(entry.rows),
      String(entry.sessions),
      formatShare(entry.positives.meaningful, entry.rows),
      formatShare(entry.positives.quick_skip, entry.rows),
      formatShare(entry.positives.negative, entry.rows),
    ]),
  ], ['left', 'right', 'right', 'right', 'right', 'right']));
  return lines;
}

function formatValueModel(values: FeedRankerActionValues): string {
  return FEED_RANKER_ACTIONS
    .filter((action) => values[action] !== 0)
    .map((action, index) => {
      const value = values[action];
      const sign = value < 0 ? '− ' : index === 0 ? '' : '+ ';
      return `${sign}${Math.abs(value)}·p(${ACTION_LABELS[action]})`;
    })
    .join(' ');
}

export function formatFeedRankerReplay(
  replay: FeedRankerReplay,
  candidateLabel: string,
): string[] {
  const lines = [
    `Replay of the ${replay.sessions} holdout sessions: each session's rendered items re-ranked by the base score `
      + '(Σ weight × stored feature; no diversity rules, multipliers or cold-start slot). '
      + `${replay.sessionsAboveTopK} of them have more than ${replay.topK} items, the only ones whose `
      + `top ${replay.topK} can change.`,
  ];
  if (replay.sessions === 0) {
    lines.push('  No holdout sessions to replay.');
    return lines;
  }
  const arm = (label: string, entry: FeedRankerReplayArm) => [
    `  ${label}`,
    String(entry.items),
    formatShare(entry.meaningful, entry.items),
    formatShare(entry.quickSkips, entry.items),
  ];
  lines.push(...alignColumns([
    ['  ORDER', `TOP-${replay.topK} ITEMS`, 'MEANINGFUL', 'QUICK SKIPS'],
    arm('as served', replay.logged),
    arm('live weights', replay.live),
    arm(candidateLabel, replay.candidate),
  ], ['left', 'right', 'right', 'right']));
  return lines;
}

function formatWeightTable(
  liveLabel: string,
  liveWeights: Readonly<FeedRankerWeights>,
  candidateLabel: string,
  candidateWeights: Readonly<FeedRankerWeights>,
  notes: ReadonlyMap<FeedRankerWeightKey, string> = new Map(),
): string[] {
  return alignColumns([
    ['  KEY', liveLabel.toUpperCase(), candidateLabel.toUpperCase(), ''],
    ...FEED_RANKER_WEIGHT_KEYS.map((key) => [
      `  ${key}`,
      formatWeight(liveWeights[key]),
      formatWeight(candidateWeights[key]),
      notes.get(key) ?? '',
    ]),
  ], ['left', 'right', 'right', 'left']);
}

export function formatFeedRankerTraining(
  result: FeedRankerTrainingResult,
  context: { values: FeedRankerActionValues; liveLabel: string },
): string[] {
  const lines = [
    `Split by session (seed ${FEED_RANKER_SPLIT_SEED}): train ${result.trainSessions} sessions, `
      + `${result.trainRows} rows · holdout ${result.holdoutSessions} sessions, ${result.holdoutRows} rows.`,
    `Model: per action, a logistic regression with an L2 penalty (λ ${FEED_RANKER_L2}) by full-batch gradient `
      + `descent over ${FEED_RANKER_FEATURES.length} standardised features, position among them.`,
    '',
  ];

  lines.push(...alignColumns([
    ['  HOLDOUT', 'LOG-LOSS', 'BASELINE', 'AUC', 'POSITIVES TRAIN/HOLDOUT', 'FIT'],
    ...result.fits.map((fit) => [
      `  ${ACTION_LABELS[fit.action]}`,
      formatNumber(fit.holdoutLogLoss, 4),
      formatNumber(fit.baselineLogLoss, 4),
      formatNumber(fit.holdoutAuc, 3),
      `${fit.trainPositives}/${fit.holdoutPositives}`,
      fit.model
        ? `${fit.model.iterations} iterations${fit.model.converged ? '' : ' (not converged)'}`
        : 'not fitted: the training rows need a positive and a negative',
    ]),
  ], ['left', 'right', 'right', 'right', 'right', 'left']));
  lines.push(
    '  Baseline: a constant at the training rate. AUC 0.5 is chance; – means the holdout lacks a positive or a negative.',
    '',
    'Coefficients: change in log-odds per standard deviation (0 = never varied in the training rows).',
  );
  lines.push(...alignColumns([
    ['  FEATURE', ...result.fits.map((fit) => ACTION_LABELS[fit.action].toUpperCase())],
    ...FEED_RANKER_FEATURES.map((feature, index) => [
      `  ${feature}`,
      ...result.fits.map((fit) => (fit.model ? fit.model.standardizedCoefficients[index].toFixed(3) : DASH)),
    ]),
  ], ['left', 'right', 'right', 'right']));

  const { rescale } = result;
  const scaling = rescale.factor === null
    ? 'not rescaled: '
      + (rescale.fittedPositiveSum > 0
        ? `${context.liveLabel} has no positive weight.`
        : 'no fitted weight is positive, so there is no positive sum to match.')
    : `then ×${rescale.factor.toFixed(3)} so the positive weights sum to ${context.liveLabel}'s `
      + `${formatWeight(rescale.livePositiveSum)}.`;
  lines.push(
    '',
    `Weights: ${formatValueModel(context.values)} at the top slot, linearised at the training means `
      + `(w = Σ value · coefficient · p(1 − p)), ${scaling}`,
  );
  const notes = new Map<FeedRankerWeightKey, string>();
  for (const key of result.unvariedKeys) notes.set(key, 'never varied in the training rows: not learnable');
  for (const key of result.clampedKeys) {
    notes.set(key, `clamped to ${FEED_RANKER_WEIGHT_BOUNDS.min}..${FEED_RANKER_WEIGHT_BOUNDS.max}`);
  }
  lines.push(...formatWeightTable('live', result.liveWeights, 'draft', result.weights, notes));
  lines.push('', ...formatFeedRankerReplay(result.replay, 'draft weights'));
  return lines;
}

// ---------------------------------------------------------------------------
// Commands

export type FeedRankerCliOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type FeedRankerCliDeps = {
  /** Injected in tests; otherwise a service-role client is built from `environment`. */
  client?: SupabaseClient;
  environment?: NodeJS.ProcessEnv;
  output?: FeedRankerCliOutput;
  /** The clock for the window and the draft's date. */
  now?: () => Date;
};

function createServiceRoleClient(environment: NodeJS.ProcessEnv): SupabaseClient {
  const url = environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function logLines(output: FeedRankerCliOutput, lines: readonly string[]): void {
  for (const line of lines) output.log(line);
}

function requireLiveVersion(versions: readonly FeedRankerVersion[], algorithmKey: string): FeedRankerVersion {
  const live = versions.find((version) => version.status === 'active');
  if (!live) {
    throw new Error(`No ${algorithmKey} version is active: there are no live weights to compare with.`);
  }
  return live;
}

async function runTrain(
  client: SupabaseClient,
  command: Extract<FeedRankerCommand, { command: 'train' }>,
  input: {
    examples: FeedRankerExample[];
    summary: FeedRankerDatasetSummary;
    live: FeedRankerVersion;
    now: Date;
  },
  output: FeedRankerCliOutput,
) {
  if (input.examples.length === 0) {
    throw new Error('Nothing to train on: no rendered deliveries in the window.');
  }
  const liveWeights = effectiveFeedRankerWeights(input.live.weights);
  const liveLabel = versionLabel(input.live);
  const result = trainFeedRanker(input.examples, { values: command.values, liveWeights });
  output.log('');
  logLines(output, formatFeedRankerTraining(result, { values: command.values, liveLabel }));

  const floor = checkFeedRankerSampleFloor(input.summary, command);
  output.log('');
  logLines(output, floor.lines);
  output.log('');
  output.log('Draft weights JSON (for replay --weights):');
  output.log(JSON.stringify(result.weights));

  if (!command.apply) {
    if (!floor.passed) {
      output.log(command.force
        ? 'Below the sample floor: --apply --force would write the draft anyway.'
        : 'Below the sample floor: --apply would be refused without --force.');
    }
    output.log(`Dry run: nothing was changed. Re-run with --apply to call ${DRAFT_RPC}.`);
    return;
  }
  if (!floor.passed && !command.force) {
    throw new Error(
      `Refusing --apply: below the sample floor (${floor.failures.join('; ')}). `
      + 'Re-run with --force to write the draft anyway.',
    );
  }
  const mismatches = feedRankerWeightsNormalizerMismatches(result.weights);
  if (mismatches.length > 0) {
    throw new Error(`Refusing --apply: the feed would not read the fitted weights as fitted (${mismatches.join('; ')}).`);
  }
  if (!floor.passed) output.log(`Forced: writing the draft below the sample floor (${floor.failures.join('; ')}).`);

  const payload: CreateFeedAlgorithmVersionDraftPayload = {
    p_algorithm_key: command.algorithmKey,
    p_description: feedRankerDraftDescription({
      now: input.now,
      rendered: input.summary.rows,
      days: command.days,
      values: command.values,
      fits: result.fits,
    }),
    p_weights: result.weights,
    p_retrieval_config: input.live.retrievalConfig,
    p_diversity_config: input.live.diversityConfig,
  };
  const { data, error } = await client.rpc(DRAFT_RPC, payload);
  if (error) throw new Error(`${DRAFT_RPC} failed: ${describeError(error)}`);
  output.log(`Applied with ${DRAFT_RPC}:`);
  output.log(JSON.stringify(data ?? null, null, 2));
  const created = data && typeof data === 'object' && !Array.isArray(data)
    ? numberFrom((data as Row).version)
    : null;
  output.log(
    `The draft serves nobody yet. Check it with npm run ops:feed-algorithm -- list; promote it with `
    + `npm run ops:feed-algorithm -- activate --key ${command.algorithmKey} --version ${created ?? '<version>'} --apply.`,
  );
}

function runReplay(
  command: Extract<FeedRankerCommand, { command: 'replay' }>,
  input: { examples: FeedRankerExample[]; live: FeedRankerVersion },
  output: FeedRankerCliOutput,
) {
  if (input.examples.length === 0) {
    throw new Error('Nothing to replay: no rendered deliveries in the window.');
  }
  const liveWeights = effectiveFeedRankerWeights(input.live.weights);
  const givenWeights = effectiveFeedRankerWeights(command.weights);
  const { holdout } = partitionFeedRankerExamples(input.examples);
  output.log('');
  output.log(
    `Weights: live is ${versionLabel(input.live)}; given is --weights, a missing key read as the feed reads it.`,
  );
  logLines(output, formatWeightTable('live', liveWeights, 'given', givenWeights));
  output.log('');
  logLines(output, formatFeedRankerReplay(
    replayFeedRankerSessions(holdout, liveWeights, givenWeights),
    'given weights',
  ));
  output.log('Offline replay only: nothing was changed.');
}

/**
 * Runs one command and resolves to the process exit code: 0 on success, 1 on
 * a usage error (printed with the usage), a refusal or a database error.
 */
export async function runFeedRankerCli(
  argv: readonly string[],
  deps: FeedRankerCliDeps = {},
): Promise<number> {
  const output = deps.output ?? {
    log: (line: string) => console.log(line),
    error: (line: string) => console.error(line),
  };

  let command: FeedRankerCommand;
  try {
    command = parseFeedRankerArgs(argv);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    output.error('');
    output.error(FEED_RANKER_USAGE);
    return 1;
  }
  if (command.command === 'help') {
    output.log(FEED_RANKER_USAGE);
    return 0;
  }

  try {
    const client = deps.client ?? createServiceRoleClient(deps.environment ?? process.env);
    const now = deps.now ? deps.now() : new Date();
    const versions = await loadVersions(client, command.algorithmKey);
    if (versions.length === 0) {
      throw new Error(`No ${command.algorithmKey} versions in feed_algorithm_versions.`);
    }
    const live = command.command === 'dataset' ? null : requireLiveVersion(versions, command.algorithmKey);
    const examples = await loadFeedRankerExamples(client, {
      versionIds: versions.map((version) => version.id),
      since: new Date(now.getTime() - command.days * DAY_MS).toISOString(),
    });
    const summary = summarizeFeedRankerDataset(examples);
    logLines(output, formatFeedRankerDataset(summary, {
      days: command.days,
      algorithmKey: command.algorithmKey,
      versions,
    }));

    if (command.command === 'train' && live) {
      await runTrain(client, command, { examples, summary, live, now }, output);
    } else if (command.command === 'replay' && live) {
      runReplay(command, { examples, live }, output);
    }
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runFeedRankerCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
