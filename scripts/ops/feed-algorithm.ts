/**
 * For You ranking operations: list the algorithm versions and experiments,
 * read the scorecard, check an experiment's sample ratio, activate a version,
 * start or stop an experiment.
 *
 * Service role only. `list`, `scorecard` and `experiment srm` only read.
 * `activate` and `experiment start|stop` print their plan and change nothing
 * without `--apply`; each write is one service-role RPC (plan
 * docs/plans/feed-algorithm-v3-x-adoption-2026-10-11.md §2.4–§2.6), and the
 * CLI refuses up front what those RPCs would refuse. The scorecard's viewer,
 * position and format sections and `experiment srm` read the v4 functions
 * (docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md §2.8). Nothing
 * here prints the service-role key or the database URL.
 *
 * Runbook: docs/feed-algorithm-operations.md.
 */
import { pathToFileURL } from 'node:url';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const BASIS_POINTS_TOTAL = 10_000;
const DEFAULT_TREATMENT_BASIS_POINTS = 5_000;
const MAX_VERSION_NUMBER = 2_147_483_647;
const DEFAULT_ALGORITHM_KEY = 'for-you-rules';
const DEFAULT_SCORECARD_DAYS = 7;
const MAX_SCORECARD_DAYS = 30;
const MAX_EXPERIMENT_KEY_LENGTH = 100;
const RUNBOOK_PATH = 'docs/feed-algorithm-operations.md';
const DASH = '–';
/** Below this p-value an experiment's assignment is called skewed. */
export const SAMPLE_RATIO_P_THRESHOLD = 0.01;
/** The chi-square approximation needs every expected count at least this large. */
const SAMPLE_RATIO_MIN_EXPECTED = 5;

/** `activate_feed_algorithm_version` takes only these targets (plan §2.4). */
// A retired version can be activated again: that is how a rollback works. The
// RPC clears its retired_at in the same statement.
export const ACTIVATABLE_VERSION_STATUSES: readonly string[] = ['draft', 'shadow', 'retired'];
/** `create_feed_experiment` takes only these versions for a variant (plan §2.5). */
export const EXPERIMENT_VERSION_STATUSES: readonly string[] = ['active', 'shadow'];
export const EXPERIMENT_STOP_STATUSES = ['completed', 'cancelled', 'paused'] as const;
const FINISHED_EXPERIMENT_STATUSES: readonly string[] = ['completed', 'cancelled'];

export const FEED_ALGORITHM_USAGE = `
Magicbooklet feed algorithm operations (service role only)

Usage:
  npm run ops:feed-algorithm -- list
  npm run ops:feed-algorithm -- scorecard [--days 7] [--by version|source]
  npm run ops:feed-algorithm -- activate --key <algorithm_key> --version <n> [--apply]
  npm run ops:feed-algorithm -- experiment start --key <experiment_key> --control <version> --treatment <version>
      [--algorithm-key for-you-rules] [--traffic-bps 10000] [--treatment-bps 5000] [--apply]
  npm run ops:feed-algorithm -- experiment stop --key <experiment_key> [--status completed|cancelled|paused] [--apply]
  npm run ops:feed-algorithm -- experiment srm --key <experiment_key>

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY

Notes:
  - list, scorecard and experiment srm only read. activate and experiment start|stop print their plan and
    change nothing without --apply.
  - scorecard adds viewer-grain, position and format sections; experiment srm compares each variant's
    assigned viewers with its allocation (chi-square). Both need the feed ranking v4 migration.
  - --days is 1-30. Basis points: 10000 = 100%. --traffic-bps is the share of viewers enrolled;
    --treatment-bps is the treatment's share of enrolled viewers (control gets the rest). Both 1-10000.
  - Runbook: ${RUNBOOK_PATH}
`.trim();

export type ExperimentStopStatus = (typeof EXPERIMENT_STOP_STATUSES)[number];
export type ScorecardGrouping = 'version' | 'source';

export type FeedAlgorithmCommand =
  | { command: 'help' }
  | { command: 'list' }
  | { command: 'scorecard'; days: number; by: ScorecardGrouping }
  | { command: 'activate'; algorithmKey: string; version: number; apply: boolean }
  | {
      command: 'experiment-start';
      experimentKey: string;
      algorithmKey: string;
      controlVersion: number;
      treatmentVersion: number;
      trafficBasisPoints: number;
      treatmentBasisPoints: number;
      apply: boolean;
    }
  | {
      command: 'experiment-stop';
      experimentKey: string;
      status: ExperimentStopStatus;
      apply: boolean;
    }
  | { command: 'experiment-srm'; experimentKey: string };

/** A malformed command line: printed with the usage, exit 1. */
export class FeedAlgorithmUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedAlgorithmUsageError';
  }
}

// ---------------------------------------------------------------------------
// Arguments

type Flags = Map<string, string | true>;

function parseFlags(
  tokens: readonly string[],
  valueFlags: readonly string[],
  acceptsApply: boolean,
): Flags {
  const flags: Flags = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new FeedAlgorithmUsageError(`Unexpected argument: ${token}`);
    if (flags.has(token)) throw new FeedAlgorithmUsageError(`Duplicate option: ${token}`);
    if (token === '--apply' && acceptsApply) {
      flags.set(token, true);
      continue;
    }
    // Unknown options fail instead of being ignored: a mistyped --treatment-bps
    // would otherwise apply the default allocation.
    if (!valueFlags.includes(token)) throw new FeedAlgorithmUsageError(`Unknown option: ${token}`);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new FeedAlgorithmUsageError(`Missing value for ${token}.`);
    }
    flags.set(token, value);
    index += 1;
  }
  return flags;
}

function requireText(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || !value.trim()) {
    throw new FeedAlgorithmUsageError(`${name} is required.`);
  }
  return value.trim();
}

function optionalText(flags: Flags, name: string, fallback: string): string {
  return flags.has(name) ? requireText(flags, name) : fallback;
}

function parseWholeNumber(raw: string, name: string, min: number, max: number): number {
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new FeedAlgorithmUsageError(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function requireWholeNumber(flags: Flags, name: string, min: number, max: number): number {
  return parseWholeNumber(requireText(flags, name), name, min, max);
}

function optionalWholeNumber(
  flags: Flags,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  return flags.has(name) ? requireWholeNumber(flags, name, min, max) : fallback;
}

function isStopStatus(value: string): value is ExperimentStopStatus {
  return (EXPERIMENT_STOP_STATUSES as readonly string[]).includes(value);
}

export function parseFeedAlgorithmArgs(argv: readonly string[]): FeedAlgorithmCommand {
  const [command, ...rest] = argv;
  if (command === undefined) throw new FeedAlgorithmUsageError('Missing command.');
  if (command === 'help' || command === '--help' || rest.includes('--help')) {
    return { command: 'help' };
  }

  switch (command) {
    case 'list':
      parseFlags(rest, [], false);
      return { command: 'list' };

    case 'scorecard': {
      const flags = parseFlags(rest, ['--days', '--by'], false);
      const by = optionalText(flags, '--by', 'version');
      if (by !== 'version' && by !== 'source') {
        throw new FeedAlgorithmUsageError('--by must be version or source.');
      }
      return {
        command: 'scorecard',
        days: optionalWholeNumber(flags, '--days', DEFAULT_SCORECARD_DAYS, 1, MAX_SCORECARD_DAYS),
        by,
      };
    }

    case 'activate': {
      const flags = parseFlags(rest, ['--key', '--version'], true);
      return {
        command: 'activate',
        algorithmKey: requireText(flags, '--key'),
        version: requireWholeNumber(flags, '--version', 1, MAX_VERSION_NUMBER),
        apply: flags.get('--apply') === true,
      };
    }

    case 'experiment': {
      const [subcommand, ...tokens] = rest;
      if (subcommand === 'start') {
        const flags = parseFlags(tokens, [
          '--key',
          '--control',
          '--treatment',
          '--algorithm-key',
          '--traffic-bps',
          '--treatment-bps',
        ], true);
        const experimentKey = requireText(flags, '--key');
        if (experimentKey.length > MAX_EXPERIMENT_KEY_LENGTH) {
          throw new FeedAlgorithmUsageError(
            `--key must be at most ${MAX_EXPERIMENT_KEY_LENGTH} characters.`,
          );
        }
        return {
          command: 'experiment-start',
          experimentKey,
          algorithmKey: optionalText(flags, '--algorithm-key', DEFAULT_ALGORITHM_KEY),
          controlVersion: requireWholeNumber(flags, '--control', 1, MAX_VERSION_NUMBER),
          treatmentVersion: requireWholeNumber(flags, '--treatment', 1, MAX_VERSION_NUMBER),
          trafficBasisPoints: optionalWholeNumber(
            flags, '--traffic-bps', BASIS_POINTS_TOTAL, 1, BASIS_POINTS_TOTAL,
          ),
          treatmentBasisPoints: optionalWholeNumber(
            flags, '--treatment-bps', DEFAULT_TREATMENT_BASIS_POINTS, 1, BASIS_POINTS_TOTAL,
          ),
          apply: flags.get('--apply') === true,
        };
      }
      if (subcommand === 'stop') {
        const flags = parseFlags(tokens, ['--key', '--status'], true);
        const status = optionalText(flags, '--status', 'completed');
        if (!isStopStatus(status)) {
          throw new FeedAlgorithmUsageError('--status must be completed, cancelled or paused.');
        }
        return {
          command: 'experiment-stop',
          experimentKey: requireText(flags, '--key'),
          status,
          apply: flags.get('--apply') === true,
        };
      }
      if (subcommand === 'srm') {
        const flags = parseFlags(tokens, ['--key'], false);
        return { command: 'experiment-srm', experimentKey: requireText(flags, '--key') };
      }
      throw new FeedAlgorithmUsageError(
        subcommand === undefined
          ? 'Missing experiment command: start or stop to change an experiment, srm to check one.'
          : `Unknown experiment command: ${subcommand}`,
      );
    }

    default:
      throw new FeedAlgorithmUsageError(`Unknown command: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// Rows

export type FeedAlgorithmVersion = {
  id: string;
  algorithmKey: string;
  version: number;
  status: string;
  activatedAt: string | null;
  retiredAt: string | null;
  description: string;
};

export type FeedExperimentVariant = {
  id: string;
  variantKey: string;
  algorithmVersionId: string;
  allocationBasisPoints: number;
};

export type FeedExperiment = {
  id: string;
  experimentKey: string;
  status: string;
  trafficBasisPoints: number;
  startsAt: string | null;
  endsAt: string | null;
  variants: FeedExperimentVariant[];
};

type Row = Record<string, unknown>;

function asRow(value: unknown, source: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} returned a row that is not an object.`);
  }
  return value as Row;
}

function requiredString(row: Row, column: string, source: string): string {
  const value = row[column];
  if (typeof value !== 'string' || !value) {
    throw new Error(`${source} returned a row without ${column}.`);
  }
  return value;
}

function optionalString(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' && value ? value : null;
}

/** PostgREST sends bigint as a JSON number; a numeric string is accepted too. */
function numberFrom(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function requiredWholeNumber(row: Row, column: string, source: string): number {
  const value = numberFrom(row[column]);
  if (value === null || !Number.isSafeInteger(value)) {
    throw new Error(`${source} returned a row without a whole ${column}.`);
  }
  return value;
}

function normalizeVersion(value: unknown): FeedAlgorithmVersion {
  const source = 'feed_algorithm_versions';
  const row = asRow(value, source);
  return {
    id: requiredString(row, 'id', source),
    algorithmKey: requiredString(row, 'algorithm_key', source),
    version: requiredWholeNumber(row, 'version', source),
    status: requiredString(row, 'status', source),
    activatedAt: optionalString(row, 'activated_at'),
    retiredAt: optionalString(row, 'retired_at'),
    description: optionalString(row, 'description') ?? '',
  };
}

function normalizeVariant(value: unknown): FeedExperimentVariant {
  const source = 'feed_experiment_variants';
  const row = asRow(value, source);
  return {
    id: requiredString(row, 'id', source),
    variantKey: requiredString(row, 'variant_key', source),
    algorithmVersionId: requiredString(row, 'algorithm_version_id', source),
    allocationBasisPoints: requiredWholeNumber(row, 'allocation_basis_points', source),
  };
}

function normalizeExperiment(value: unknown): FeedExperiment {
  const source = 'feed_experiments';
  const row = asRow(value, source);
  const variants: unknown[] = Array.isArray(row.feed_experiment_variants)
    ? row.feed_experiment_variants
    : [];
  return {
    id: requiredString(row, 'id', source),
    experimentKey: requiredString(row, 'experiment_key', source),
    status: requiredString(row, 'status', source),
    trafficBasisPoints: requiredWholeNumber(row, 'traffic_basis_points', source),
    startsAt: optionalString(row, 'starts_at'),
    endsAt: optionalString(row, 'ends_at'),
    // Same order the feed buckets them in (src/lib/feed-experiments.ts).
    variants: variants
      .map((variant) => normalizeVariant(variant))
      .sort((left, right) => left.variantKey.localeCompare(right.variantKey)),
  };
}

export function feedAlgorithmVersionLabel(version: { algorithmKey: string; version: number }) {
  return `${version.algorithmKey}-v${version.version}`;
}

// ---------------------------------------------------------------------------
// Database

type DatabaseError = { message?: string; code?: string };

/** `migration`: the feed ranking migration that adds the function called. */
function describeError(error: DatabaseError, migration: 'v3' | 'v4' = 'v3'): string {
  const message = error.message || 'unknown error';
  if (error.code === 'PGRST202') {
    return `${message} (is the feed ranking ${migration} migration applied?)`;
  }
  return error.code ? `${message} (${error.code})` : message;
}

async function loadVersions(client: SupabaseClient): Promise<FeedAlgorithmVersion[]> {
  const { data, error } = await client
    .from('feed_algorithm_versions')
    .select('id, algorithm_key, version, status, activated_at, retired_at, description')
    .order('algorithm_key', { ascending: true })
    .order('version', { ascending: true });
  if (error) throw new Error(`Reading feed_algorithm_versions failed: ${describeError(error)}`);
  const rows: unknown[] = data ?? [];
  return rows.map((row) => normalizeVersion(row));
}

async function loadExperiments(client: SupabaseClient): Promise<FeedExperiment[]> {
  const { data, error } = await client
    .from('feed_experiments')
    .select(
      'id, experiment_key, status, traffic_basis_points, starts_at, ends_at, created_at, '
      + 'feed_experiment_variants(id, variant_key, algorithm_version_id, allocation_basis_points)',
    )
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Reading feed_experiments failed: ${describeError(error)}`);
  const rows: unknown[] = data ?? [];
  return rows.map((row) => normalizeExperiment(row));
}

async function callRpc(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  migration: 'v3' | 'v4' = 'v3',
): Promise<unknown> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${describeError(error, migration)}`);
  return data;
}

// ---------------------------------------------------------------------------
// Formatting

function formatTimestamp(value: string | null): string {
  if (!value) return DASH;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatBasisPoints(basisPoints: number): string {
  return `${basisPoints} bps (${(basisPoints / 100).toFixed(2)}%)`;
}

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

function dryRunNotice(rpcName: string): string {
  return `Dry run: nothing was changed. Re-run with --apply to call ${rpcName}.`;
}

function versionLabelsById(versions: readonly FeedAlgorithmVersion[]): Map<string, string> {
  return new Map(versions.map((version) => [version.id, feedAlgorithmVersionLabel(version)]));
}

export function formatFeedAlgorithmList(
  versions: readonly FeedAlgorithmVersion[],
  experiments: readonly FeedExperiment[],
): string[] {
  const lines = ['Feed algorithm versions (feed_algorithm_versions)'];
  if (versions.length === 0) {
    lines.push('  none');
  } else {
    lines.push(...alignColumns([
      ['VERSION', 'STATUS', 'ACTIVATED', 'RETIRED', 'DESCRIPTION'],
      ...versions.map((version) => [
        feedAlgorithmVersionLabel(version),
        version.status,
        formatTimestamp(version.activatedAt),
        formatTimestamp(version.retiredAt),
        version.description || DASH,
      ]),
    ]).map((line) => `  ${line}`));
  }

  lines.push('', 'Feed experiments (feed_experiments)');
  if (experiments.length === 0) {
    lines.push('  none');
    return lines;
  }
  const labels = versionLabelsById(versions);
  for (const experiment of experiments) {
    const start = experiment.startsAt ? formatTimestamp(experiment.startsAt) : 'no start';
    const end = experiment.endsAt ? formatTimestamp(experiment.endsAt) : 'no end';
    lines.push(
      `  ${experiment.experimentKey}  ${experiment.status}`
      + `  traffic ${formatBasisPoints(experiment.trafficBasisPoints)}  window ${start} → ${end}`,
    );
    if (experiment.variants.length === 0) {
      lines.push('    no variants');
      continue;
    }
    lines.push(...alignColumns(experiment.variants.map((variant) => [
      `    ${variant.variantKey}`,
      labels.get(variant.algorithmVersionId) ?? `version ${variant.algorithmVersionId}`,
      formatBasisPoints(variant.allocationBasisPoints),
    ])));
  }
  const running = experiments.filter((experiment) => experiment.status === 'running');
  if (running.length > 1) {
    lines.push(
      '',
      `Note: ${running.length} experiments are running; the feed enrols viewers only in the oldest `
      + `running one inside its window (${running[0].experimentKey}).`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Scorecard

export type ScorecardCounts = {
  served: number;
  rendered: number;
  qualified: number;
  meaningful: number;
  quickSkips: number;
  negatives: number;
  saves: number;
  remixStarts: number;
  distinctViewers: number;
  repeatExposures: number;
  avgPosition: number | null;
};

export type ScorecardRate = {
  label: string;
  numerator: number;
  denominator: number;
  unit: 'percent' | 'per_1k' | 'seconds';
  /** In `unit`; null when the denominator is zero. */
  value: number | null;
};

export type ScorecardLine = {
  versionLabel: string;
  /** `no experiment`, `<experiment_key>/<variant_key>`, or `variant <key>` if the experiment is gone. */
  armLabel: string;
  inExperiment: boolean;
  /** Null when the line covers every candidate source. */
  source: string | null;
  counts: ScorecardCounts;
  /**
   * False when several rows were added up: `counts.distinctViewers` is then
   * their sum, an upper bound (a viewer who saw several sources counts once
   * per source), and `distinctViewersLowerBound` the largest single row.
   */
  distinctViewersExact: boolean;
  distinctViewersLowerBound: number;
  rates: ScorecardRate[];
};

type ScorecardRow = ScorecardCounts & {
  algorithmVersionId: string | null;
  algorithmLabel: string | null;
  experimentVariantId: string | null;
  variantKey: string | null;
  candidateSource: string | null;
};

const SCORECARD_SOURCE = 'feed_algorithm_scorecard';

function scorecardColumn(row: Row, column: string): unknown {
  // A missing column is a contract mismatch with the SQL, not a zero.
  if (!(column in row)) throw new Error(`${SCORECARD_SOURCE} returned no ${column} column.`);
  return row[column];
}

function scorecardCount(row: Row, column: string): number {
  const raw = scorecardColumn(row, column);
  if (raw === null) return 0;
  const value = numberFrom(raw);
  if (value === null || value < 0) throw new Error(`${SCORECARD_SOURCE} returned an invalid ${column}.`);
  return value;
}

function normalizeScorecardRow(value: unknown): ScorecardRow {
  const row = asRow(value, SCORECARD_SOURCE);
  const position = scorecardColumn(row, 'avg_position');
  return {
    algorithmVersionId: optionalString(row, 'algorithm_version_id'),
    algorithmLabel: optionalString(row, 'algorithm_label'),
    experimentVariantId: optionalString(row, 'experiment_variant_id'),
    variantKey: optionalString(row, 'variant_key'),
    candidateSource: optionalString(row, 'candidate_source'),
    served: scorecardCount(row, 'served'),
    rendered: scorecardCount(row, 'rendered'),
    qualified: scorecardCount(row, 'qualified'),
    meaningful: scorecardCount(row, 'meaningful'),
    quickSkips: scorecardCount(row, 'quick_skips'),
    negatives: scorecardCount(row, 'negatives'),
    saves: scorecardCount(row, 'saves'),
    remixStarts: scorecardCount(row, 'remix_starts'),
    distinctViewers: scorecardCount(row, 'distinct_viewers'),
    repeatExposures: scorecardCount(row, 'repeat_exposures'),
    avgPosition: position === null ? null : numberFrom(position),
  };
}

function rateOf(numerator: number, denominator: number, multiplier: number): number | null {
  return denominator > 0 ? (numerator / denominator) * multiplier : null;
}

function percent(label: string, numerator: number, denominator: number): ScorecardRate {
  return { label, numerator, denominator, unit: 'percent', value: rateOf(numerator, denominator, 100) };
}

function perThousand(label: string, numerator: number, denominator: number): ScorecardRate {
  return { label, numerator, denominator, unit: 'per_1k', value: rateOf(numerator, denominator, 1000) };
}

export function computeScorecardRates(counts: ScorecardCounts): ScorecardRate[] {
  return [
    percent('rendered / served', counts.rendered, counts.served),
    percent('qualified / rendered', counts.qualified, counts.rendered),
    percent('meaningful / rendered', counts.meaningful, counts.rendered),
    percent('quick skips / rendered', counts.quickSkips, counts.rendered),
    perThousand('negatives per 1k rendered', counts.negatives, counts.rendered),
    perThousand('saves per 1k rendered', counts.saves, counts.rendered),
    perThousand('remix starts per 1k rendered', counts.remixStarts, counts.rendered),
    percent('repeat exposures / served', counts.repeatExposures, counts.served),
  ];
}

export function formatScorecardRate(rate: ScorecardRate): string {
  if (rate.value === null) return DASH;
  if (rate.unit === 'percent') return `${rate.value.toFixed(1)}%`;
  return rate.unit === 'seconds' ? `${rate.value.toFixed(1)} s` : rate.value.toFixed(1);
}

// ---------------------------------------------------------------------------
// Arms: a version and an experiment variant, the grain of every section

type ArmColumns = {
  algorithmVersionId: string | null;
  algorithmLabel: string | null;
  experimentVariantId: string | null;
  variantKey: string | null;
};

export type ScorecardArm = {
  versionLabel: string;
  /** `no experiment`, `<experiment_key>/<variant_key>`, or `variant <key>` if the experiment is gone. */
  armLabel: string;
  inExperiment: boolean;
};

type ResolvedArm = { order: number; arm: ScorecardArm };

/**
 * Labels a row's version (joined from `feed_algorithm_versions`, else the
 * function's own label) and its experiment arm; `order` is the version's
 * place in the version list.
 */
function scorecardArmResolver(
  versions: readonly FeedAlgorithmVersion[],
  experiments: readonly FeedExperiment[],
): (row: ArmColumns) => ResolvedArm {
  const versionOrder = new Map(versions.map((version, index) => [version.id, index]));
  const versionLabels = versionLabelsById(versions);
  const armLabels = new Map<string, string>();
  for (const experiment of experiments) {
    for (const variant of experiment.variants) {
      armLabels.set(variant.id, `${experiment.experimentKey}/${variant.variantKey}`);
    }
  }
  return (row) => ({
    order: (row.algorithmVersionId ? versionOrder.get(row.algorithmVersionId) : undefined)
      ?? Number.MAX_SAFE_INTEGER,
    arm: {
      versionLabel: (row.algorithmVersionId ? versionLabels.get(row.algorithmVersionId) : undefined)
        ?? row.algorithmLabel ?? row.algorithmVersionId ?? 'unknown version',
      armLabel: row.experimentVariantId === null
        ? 'no experiment'
        : armLabels.get(row.experimentVariantId) ?? `variant ${row.variantKey ?? row.experimentVariantId}`,
      inExperiment: row.experimentVariantId !== null,
    },
  });
}

function armColumns(row: Row): ArmColumns {
  return {
    algorithmVersionId: optionalString(row, 'algorithm_version_id'),
    algorithmLabel: optionalString(row, 'algorithm_label'),
    experimentVariantId: optionalString(row, 'experiment_variant_id'),
    variantKey: optionalString(row, 'variant_key'),
  };
}

function groupByArm<T extends ArmColumns>(rows: readonly T[]): T[][] {
  const arms = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.algorithmVersionId ?? ''}|${row.experimentVariantId ?? ''}`;
    const members = arms.get(key);
    if (members) members.push(row);
    else arms.set(key, [row]);
  }
  return [...arms.values()];
}

/** Version list order, then label, then outside-experiment first, then arm. */
function compareArms(left: ResolvedArm, right: ResolvedArm): number {
  return left.order - right.order
    || left.arm.versionLabel.localeCompare(right.arm.versionLabel)
    || Number(left.arm.inExperiment) - Number(right.arm.inExperiment)
    || left.arm.armLabel.localeCompare(right.arm.armLabel);
}

function combineScorecardRows(rows: readonly ScorecardRow[]): ScorecardCounts {
  const total = (pick: (row: ScorecardRow) => number) => (
    rows.reduce((sum, row) => sum + pick(row), 0)
  );
  // Mean position across rows is weighted by each row's served deliveries.
  const positioned = rows.filter((row) => row.avgPosition !== null && row.served > 0);
  const positionedServed = positioned.reduce((sum, row) => sum + row.served, 0);
  const avgPosition = rows.length === 1
    ? rows[0].avgPosition
    : positionedServed > 0
      ? positioned.reduce((sum, row) => sum + (row.avgPosition ?? 0) * row.served, 0) / positionedServed
      : null;
  return {
    served: total((row) => row.served),
    rendered: total((row) => row.rendered),
    qualified: total((row) => row.qualified),
    meaningful: total((row) => row.meaningful),
    quickSkips: total((row) => row.quickSkips),
    negatives: total((row) => row.negatives),
    saves: total((row) => row.saves),
    remixStarts: total((row) => row.remixStarts),
    distinctViewers: total((row) => row.distinctViewers),
    repeatExposures: total((row) => row.repeatExposures),
    avgPosition,
  };
}

/**
 * Groups the scorecard rows per version and experiment arm (`--by version`),
 * or per version, arm and candidate source (`--by source`). The version label
 * is joined from `feed_algorithm_versions`. A row whose `candidate_source` is
 * null is taken as the arm's all-sources total (facts always carry a source),
 * so if the SQL returns such totals the version line uses them and its
 * distinct-viewer count is exact; otherwise the per-source rows are summed and
 * distinct viewers becomes a range (largest source to sum of sources).
 */
export function buildScorecardLines(
  rawRows: readonly unknown[],
  by: ScorecardGrouping,
  versions: readonly FeedAlgorithmVersion[],
  experiments: readonly FeedExperiment[],
): ScorecardLine[] {
  const resolveArm = scorecardArmResolver(versions, experiments);
  const lines: Array<{ line: ScorecardLine; order: number }> = [];
  for (const members of groupByArm(rawRows.map((value) => normalizeScorecardRow(value)))) {
    const { order, arm } = resolveArm(members[0]);
    const describe = (rows: readonly ScorecardRow[], source: string | null) => {
      const counts = combineScorecardRows(rows);
      lines.push({
        order,
        line: {
          ...arm,
          source,
          counts,
          distinctViewersExact: rows.length === 1,
          distinctViewersLowerBound: Math.max(0, ...rows.map((row) => row.distinctViewers)),
          rates: computeScorecardRates(counts),
        },
      });
    };

    const totals = members.filter((row) => row.candidateSource === null);
    const sourced = members.filter((row) => row.candidateSource !== null);
    if (by === 'version' || sourced.length === 0) {
      describe(totals.length > 0 ? totals : sourced, null);
      continue;
    }
    const bySource = new Map<string, ScorecardRow[]>();
    for (const row of sourced) {
      const source = row.candidateSource ?? '';
      const rows = bySource.get(source);
      if (rows) rows.push(row);
      else bySource.set(source, [row]);
    }
    for (const [source, rows] of bySource) describe(rows, source);
  }

  return lines
    .sort((left, right) => (
      left.order - right.order
      || left.line.versionLabel.localeCompare(right.line.versionLabel)
      || Number(left.line.inExperiment) - Number(right.line.inExperiment)
      || left.line.armLabel.localeCompare(right.line.armLabel)
      || right.line.counts.served - left.line.counts.served
      || (left.line.source ?? '').localeCompare(right.line.source ?? '')
    ))
    .map(({ line }) => line);
}

export function formatScorecard(
  lines: readonly ScorecardLine[],
  days: number,
  by: ScorecardGrouping,
): string[] {
  const period = `${days} ${days === 1 ? 'day' : 'days'}`;
  const output = [
    `Feed scorecard: deliveries served in the last ${period}, by ${by}.`,
    `A before/after guardrail read, not a significance test (${RUNBOOK_PATH}).`,
  ];
  if (lines.length === 0) {
    output.push('', `No deliveries were served in the last ${period}.`);
    return output;
  }
  for (const line of lines) {
    const scope = line.source !== null
      ? `source ${line.source}`
      : by === 'source' ? 'all sources' : null;
    output.push('', [line.versionLabel, line.armLabel, scope].filter(Boolean).join(' · '));
    const viewers = line.distinctViewersExact
      || line.distinctViewersLowerBound === line.counts.distinctViewers
      ? String(line.counts.distinctViewers)
      : `between ${line.distinctViewersLowerBound} and ${line.counts.distinctViewers} (sources overlap)`;
    const position = line.counts.avgPosition === null ? DASH : line.counts.avgPosition.toFixed(1);
    output.push(`  served ${line.counts.served} · distinct viewers ${viewers} · mean position ${position}`);
    output.push(...alignColumns(line.rates.map((rate) => [
      `  ${rate.label}`,
      `${rate.numerator} / ${rate.denominator}`,
      formatScorecardRate(rate),
    ]), ['left', 'right', 'right']));
  }
  return output;
}

// ---------------------------------------------------------------------------
// Scorecard v2: viewer grain, position buckets and formats (plan v4 §2.8)

export const SCORECARD_SECTION_FUNCTIONS = [
  'feed_scorecard_viewers',
  'feed_scorecard_positions',
  'feed_scorecard_formats',
] as const;
export type ScorecardSectionFunction = (typeof SCORECARD_SECTION_FUNCTIONS)[number];

/** A section's rows, or why the database has none to give (its function is missing). */
export type ScorecardSectionResult = { rows: readonly unknown[] } | { unavailable: string };

export type ScorecardV2Sections = Record<ScorecardSectionFunction, ScorecardSectionResult>;

/** The scorecard's position buckets, top of the feed first (1-based, as shown). */
export const SCORECARD_POSITION_BUCKETS: readonly string[] = ['1-3', '4-6', '7-12', '13+'];

function sectionColumn(row: Row, column: string, source: string): unknown {
  // A missing column is a contract mismatch with the SQL, not a zero.
  if (!(column in row)) throw new Error(`${source} returned no ${column} column.`);
  return row[column];
}

function sectionCount(row: Row, column: string, source: string): number {
  const raw = sectionColumn(row, column, source);
  if (raw === null) return 0;
  const value = numberFrom(raw);
  if (value === null || value < 0) throw new Error(`${source} returned an invalid ${column}.`);
  return value;
}

/** A non-negative ratio; null when the function had no denominator. */
function sectionRatio(row: Row, column: string, source: string): number | null {
  const raw = sectionColumn(row, column, source);
  if (raw === null) return null;
  const value = numberFrom(raw);
  if (value === null || value < 0) throw new Error(`${source} returned an invalid ${column}.`);
  return value;
}

export type ViewerRateCounts = {
  /** Viewers served on a day whose next day is a whole day inside the window, and those served again then. */
  d1EligibleViewers: number;
  d1ReturnedViewers: number;
  /** The same seven days out. */
  d7EligibleViewers: number;
  d7ReturnedViewers: number;
  /**
   * Viewers served with an account id (registered accounts and the app's guests), and those with a
   * completed generation within 7 days of their first serve.
   */
  signedInViewers: number;
  meaningfulCreators7d: number;
};

/**
 * Who the viewers are (supabase/migrations/20261014053528_feed_scorecard_viewer_split.sql):
 * registered + app guests = signed in, and signed in + web guests = viewers.
 */
export type ViewerAccountSplit = {
  registeredViewers: number;
  /** Anonymous accounts: the app's guests, whom the feed ranks as users. */
  anonymousViewers: number;
  /** No account id: a web visitor's feed cookie, or an app installation with no session yet. */
  webGuestViewers: number;
};

export type ViewerScorecardLine = ScorecardArm & ViewerRateCounts & {
  viewers: number;
  sessions: number;
  sessionsPerViewer: number | null;
  renderedPerViewer: number | null;
  meaningfulPerViewer: number | null;
  /** Null when the database's function predates the split. */
  accountSplit: ViewerAccountSplit | null;
  /** D1 return, D7 return and 7-day meaningful creation, from the counts. */
  rates: ScorecardRate[];
};

/**
 * The viewer-grain rates from the counts `feed_scorecard_viewers` returns with
 * them, so each prints its numerator and denominator as the delivery block does.
 */
export function computeViewerRates(counts: ViewerRateCounts): ScorecardRate[] {
  return [
    percent('D1 return', counts.d1ReturnedViewers, counts.d1EligibleViewers),
    percent('D7 return', counts.d7ReturnedViewers, counts.d7EligibleViewers),
    percent('7-day meaningful creation', counts.meaningfulCreators7d, counts.signedInViewers),
  ];
}

const VIEWERS_SOURCE = 'feed_scorecard_viewers';
const POSITIONS_SOURCE = 'feed_scorecard_positions';
const FORMATS_SOURCE = 'feed_scorecard_formats';

const VIEWER_SPLIT_COLUMNS = ['registered_viewers', 'anonymous_viewers', 'web_guest_viewers'] as const;

/**
 * The split by account, or null from a database without the split migration, whose function returns
 * none of its three columns. One or two of them is a contract mismatch, and so is a split that does not
 * add up to the signed-in viewers and the viewers.
 */
function viewerAccountSplit(row: Row, signedInViewers: number, viewers: number): ViewerAccountSplit | null {
  if (VIEWER_SPLIT_COLUMNS.every((column) => !(column in row))) return null;
  const split: ViewerAccountSplit = {
    registeredViewers: sectionCount(row, 'registered_viewers', VIEWERS_SOURCE),
    anonymousViewers: sectionCount(row, 'anonymous_viewers', VIEWERS_SOURCE),
    webGuestViewers: sectionCount(row, 'web_guest_viewers', VIEWERS_SOURCE),
  };
  if (split.registeredViewers + split.anonymousViewers !== signedInViewers
    || signedInViewers + split.webGuestViewers !== viewers) {
    throw new Error(`${VIEWERS_SOURCE} returned an account split that does not add up to its viewers.`);
  }
  return split;
}

/** One line per version and arm from `feed_scorecard_viewers`. */
export function buildViewerScorecardLines(
  rawRows: readonly unknown[],
  versions: readonly FeedAlgorithmVersion[],
  experiments: readonly FeedExperiment[],
): ViewerScorecardLine[] {
  const resolveArm = scorecardArmResolver(versions, experiments);
  return rawRows
    .map((value) => {
      const row = asRow(value, VIEWERS_SOURCE);
      const resolved = resolveArm(armColumns(row));
      const counts: ViewerRateCounts = {
        d1EligibleViewers: sectionCount(row, 'd1_eligible_viewers', VIEWERS_SOURCE),
        d1ReturnedViewers: sectionCount(row, 'd1_returned_viewers', VIEWERS_SOURCE),
        d7EligibleViewers: sectionCount(row, 'd7_eligible_viewers', VIEWERS_SOURCE),
        d7ReturnedViewers: sectionCount(row, 'd7_returned_viewers', VIEWERS_SOURCE),
        signedInViewers: sectionCount(row, 'signed_in_viewers', VIEWERS_SOURCE),
        meaningfulCreators7d: sectionCount(row, 'meaningful_creators_7d', VIEWERS_SOURCE),
      };
      const viewers = sectionCount(row, 'viewers', VIEWERS_SOURCE);
      return {
        ...resolved,
        line: {
          ...resolved.arm,
          viewers,
          sessions: sectionCount(row, 'sessions', VIEWERS_SOURCE),
          sessionsPerViewer: sectionRatio(row, 'sessions_per_viewer', VIEWERS_SOURCE),
          renderedPerViewer: sectionRatio(row, 'rendered_per_viewer', VIEWERS_SOURCE),
          meaningfulPerViewer: sectionRatio(row, 'meaningful_per_viewer', VIEWERS_SOURCE),
          ...counts,
          accountSplit: viewerAccountSplit(row, counts.signedInViewers, viewers),
          rates: computeViewerRates(counts),
        },
      };
    })
    .sort(compareArms)
    .map(({ line }) => line);
}

export type PositionBucketCounts = {
  served: number;
  rendered: number;
  meaningful: number;
  quickSkips: number;
};

export type PositionBucketLine = PositionBucketCounts & { bucket: string; rates: ScorecardRate[] };

export type PositionScorecardLine = ScorecardArm & { buckets: PositionBucketLine[] };

export function computePositionBucketRates(counts: PositionBucketCounts): ScorecardRate[] {
  return [
    percent('rendered / served', counts.rendered, counts.served),
    percent('meaningful / rendered', counts.meaningful, counts.rendered),
    percent('quick skips / rendered', counts.quickSkips, counts.rendered),
  ];
}

function bucketOrder(bucket: string): number {
  const index = SCORECARD_POSITION_BUCKETS.indexOf(bucket);
  return index === -1 ? SCORECARD_POSITION_BUCKETS.length : index;
}

/** One line per version and arm from `feed_scorecard_positions`, buckets top first. */
export function buildPositionScorecardLines(
  rawRows: readonly unknown[],
  versions: readonly FeedAlgorithmVersion[],
  experiments: readonly FeedExperiment[],
): PositionScorecardLine[] {
  const resolveArm = scorecardArmResolver(versions, experiments);
  const rows = rawRows.map((value) => {
    const row = asRow(value, POSITIONS_SOURCE);
    const bucket = sectionColumn(row, 'position_bucket', POSITIONS_SOURCE);
    if (typeof bucket !== 'string' || !bucket) {
      throw new Error(`${POSITIONS_SOURCE} returned an invalid position_bucket.`);
    }
    const counts: PositionBucketCounts = {
      served: sectionCount(row, 'served', POSITIONS_SOURCE),
      rendered: sectionCount(row, 'rendered', POSITIONS_SOURCE),
      meaningful: sectionCount(row, 'meaningful', POSITIONS_SOURCE),
      quickSkips: sectionCount(row, 'quick_skips', POSITIONS_SOURCE),
    };
    return { ...armColumns(row), bucket, counts };
  });
  return groupByArm(rows)
    .map((members) => {
      const resolved = resolveArm(members[0]);
      return {
        ...resolved,
        line: {
          ...resolved.arm,
          buckets: members
            .map(({ bucket, counts }) => ({ bucket, ...counts, rates: computePositionBucketRates(counts) }))
            .sort((left, right) => (
              bucketOrder(left.bucket) - bucketOrder(right.bucket) || left.bucket.localeCompare(right.bucket)
            )),
        },
      };
    })
    .sort(compareArms)
    .map(({ line }) => line);
}

export type FormatCounts = {
  rendered: number;
  meaningful: number;
  quickSkips: number;
  /** Σ dwell_ms_max over the rendered deliveries. */
  attentionMs: number;
  videoHalfCompletions: number;
};

export type FormatLine = FormatCounts & {
  /** `posts.category`; `unknown` when the function returns none. */
  category: string;
  rates: ScorecardRate[];
};

export type FormatScorecardLine = ScorecardArm & { formats: FormatLine[] };

export function computeFormatRates(category: string, counts: FormatCounts): ScorecardRate[] {
  const attentionSeconds = counts.attentionMs / 1000;
  return [
    percent('meaningful / rendered', counts.meaningful, counts.rendered),
    percent('quick skips / rendered', counts.quickSkips, counts.rendered),
    {
      label: 'attention per rendered',
      numerator: attentionSeconds,
      denominator: counts.rendered,
      unit: 'seconds',
      value: rateOf(attentionSeconds, counts.rendered, 1),
    },
    // Only a video has progress to half-complete: other formats have no rate.
    percent(
      'video half-completions / rendered',
      counts.videoHalfCompletions,
      category === 'video' ? counts.rendered : 0,
    ),
  ];
}

/** One line per version and arm from `feed_scorecard_formats`, busiest format first. */
export function buildFormatScorecardLines(
  rawRows: readonly unknown[],
  versions: readonly FeedAlgorithmVersion[],
  experiments: readonly FeedExperiment[],
): FormatScorecardLine[] {
  const resolveArm = scorecardArmResolver(versions, experiments);
  const rows = rawRows.map((value) => {
    const row = asRow(value, FORMATS_SOURCE);
    const category = sectionColumn(row, 'category', FORMATS_SOURCE);
    const counts: FormatCounts = {
      rendered: sectionCount(row, 'rendered', FORMATS_SOURCE),
      meaningful: sectionCount(row, 'meaningful', FORMATS_SOURCE),
      quickSkips: sectionCount(row, 'quick_skips', FORMATS_SOURCE),
      attentionMs: sectionCount(row, 'attention_ms', FORMATS_SOURCE),
      videoHalfCompletions: sectionCount(row, 'video_half_completions', FORMATS_SOURCE),
    };
    return { ...armColumns(row), category: typeof category === 'string' && category ? category : 'unknown', counts };
  });
  return groupByArm(rows)
    .map((members) => {
      const resolved = resolveArm(members[0]);
      return {
        ...resolved,
        line: {
          ...resolved.arm,
          formats: members
            .map(({ category, counts }) => ({ category, ...counts, rates: computeFormatRates(category, counts) }))
            .sort((left, right) => right.rendered - left.rendered || left.category.localeCompare(right.category)),
        },
      };
    })
    .sort(compareArms)
    .map(({ line }) => line);
}

function formatRatio(value: number | null, digits: number): string {
  return value === null ? DASH : value.toFixed(digits);
}

function sectionRateCells(rates: readonly ScorecardRate[]): string[] {
  return rates.map(formatScorecardRate);
}

/**
 * The signed-in viewers and who they are. The app's guests sign in anonymously and the feed ranks them
 * as users, so they count as signed in, in the creation rate's denominator too; the web's guests have
 * no account id.
 */
function formatViewerAccountSplit(line: ViewerScorecardLine): string {
  const signedIn = `  signed in ${line.signedInViewers}`;
  const split = line.accountSplit;
  if (!split) {
    return `${signedIn} · split by account not available (is the feed scorecard viewer split migration applied?)`;
  }
  return `${signedIn} (registered ${split.registeredViewers} · app guests ${split.anonymousViewers})`
    + ` · web guests ${split.webGuestViewers}`;
}

/**
 * The viewer, position and format sections, after the delivery-grain block.
 * Builds every line before returning, so a contract mismatch prints nothing.
 */
export function formatScorecardV2(
  sections: ScorecardV2Sections,
  days: number,
  versions: readonly FeedAlgorithmVersion[],
  experiments: readonly FeedExperiment[],
): string[] {
  const period = `${days} ${days === 1 ? 'day' : 'days'}`;
  const output: string[] = [];
  const unavailable = (section: ScorecardSectionResult) => (
    'unavailable' in section ? [`  Not available: ${section.unavailable}`] : null
  );
  const rowsOf = (section: ScorecardSectionResult) => ('rows' in section ? section.rows : []);

  output.push(
    '',
    `Viewer grain (feed_scorecard_viewers): each viewer once per version and arm, last ${period}.`,
  );
  const viewerLines = buildViewerScorecardLines(rowsOf(sections.feed_scorecard_viewers), versions, experiments);
  const viewersMissing = unavailable(sections.feed_scorecard_viewers);
  if (viewersMissing) output.push(...viewersMissing);
  else if (viewerLines.length === 0) output.push(`  No viewer was served in the last ${period}.`);
  for (const line of viewerLines) {
    output.push(
      '',
      `${line.versionLabel} · ${line.armLabel}`,
      `  viewers ${line.viewers} · sessions ${line.sessions} · sessions per viewer ${formatRatio(line.sessionsPerViewer, 2)}`,
      formatViewerAccountSplit(line),
      `  rendered per viewer ${formatRatio(line.renderedPerViewer, 1)}`
        + ` · meaningful per viewer ${formatRatio(line.meaningfulPerViewer, 1)}`,
      ...alignColumns(line.rates.map((rate) => [
        `  ${rate.label}`,
        `${rate.numerator} / ${rate.denominator}`,
        formatScorecardRate(rate),
      ]), ['left', 'right', 'right']),
    );
    if (line.viewers > 0) {
      output.push(
        `  With ${line.viewers} ${line.viewers === 1 ? 'viewer' : 'viewers'}, one viewer moves each rate `
        + `by ${(100 / line.viewers).toFixed(1)} points or more.`,
      );
    }
  }

  output.push(
    '',
    `Position buckets (feed_scorecard_positions): 1 is the top of the feed, last ${period}.`,
  );
  const positionLines = buildPositionScorecardLines(rowsOf(sections.feed_scorecard_positions), versions, experiments);
  const positionsMissing = unavailable(sections.feed_scorecard_positions);
  if (positionsMissing) output.push(...positionsMissing);
  else if (positionLines.length === 0) output.push(`  No deliveries were served in the last ${period}.`);
  for (const line of positionLines) {
    output.push('', `${line.versionLabel} · ${line.armLabel}`);
    output.push(...alignColumns([
      ['  BUCKET', 'SERVED', 'RENDERED', 'MEANINGFUL', 'QUICK SKIPS',
        'RENDERED / SERVED', 'MEANINGFUL / RENDERED', 'QUICK SKIPS / RENDERED'],
      ...line.buckets.map((bucket) => [
        `  ${bucket.bucket}`,
        String(bucket.served),
        String(bucket.rendered),
        String(bucket.meaningful),
        String(bucket.quickSkips),
        ...sectionRateCells(bucket.rates),
      ]),
    ], ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right']));
  }

  output.push('', `Formats (feed_scorecard_formats): by the post's category, last ${period}.`);
  const formatLines = buildFormatScorecardLines(rowsOf(sections.feed_scorecard_formats), versions, experiments);
  const formatsMissing = unavailable(sections.feed_scorecard_formats);
  if (formatsMissing) output.push(...formatsMissing);
  else if (formatLines.length === 0) output.push(`  No deliveries were rendered in the last ${period}.`);
  for (const line of formatLines) {
    output.push('', `${line.versionLabel} · ${line.armLabel}`);
    output.push(...alignColumns([
      ['  FORMAT', 'RENDERED', 'MEANINGFUL / RENDERED', 'QUICK SKIPS / RENDERED',
        'ATTENTION / RENDERED', 'VIDEO HALF-COMPLETIONS / RENDERED'],
      ...line.formats.map((format) => [
        `  ${format.category}`,
        String(format.rendered),
        ...sectionRateCells(format.rates),
      ]),
    ], ['left', 'right', 'right', 'right', 'right', 'right']));
  }
  return output;
}

async function loadScorecardSection(
  client: SupabaseClient,
  name: ScorecardSectionFunction,
  days: number,
): Promise<ScorecardSectionResult> {
  const { data, error } = await client.rpc(name, { p_days: days });
  if (error) {
    // The delivery-grain block above still stands without the v4 sections.
    if (error.code === 'PGRST202') {
      return { unavailable: `${name} is not in the database (is the feed ranking v4 migration applied?)` };
    }
    throw new Error(`${name} failed: ${describeError(error, 'v4')}`);
  }
  if (data !== null && !Array.isArray(data)) throw new Error(`${name} did not return rows.`);
  return { rows: data ?? [] };
}

// ---------------------------------------------------------------------------
// Sample ratio (plan v4 §2.8, feed_experiment_assignment_counts)

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let series = LANCZOS[0];
  for (let index = 1; index < LANCZOS.length; index += 1) series += LANCZOS[index] / (shifted + index);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Q(a, x) = Γ(a, x) / Γ(a), by its series below a + 1 and its continued fraction above. */
function regularizedUpperGamma(a: number, x: number): number {
  if (x <= 0) return 1;
  const prefactor = Math.exp(-x + a * Math.log(x) - logGamma(a));
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 1000; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return Math.max(0, 1 - prefactor * sum);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let fraction = d;
  for (let n = 1; n < 1000; n += 1) {
    const an = -n * (n - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    fraction *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.min(1, prefactor * fraction);
}

/** P(X ≥ statistic) for X chi-square distributed with the given degrees of freedom. */
export function chiSquareSurvival(statistic: number, degreesOfFreedom: number): number {
  if (!(degreesOfFreedom > 0)) throw new Error('Degrees of freedom must be positive.');
  if (!(statistic > 0)) return 1;
  return regularizedUpperGamma(degreesOfFreedom / 2, statistic / 2);
}

export type SampleRatioVerdict = 'skewed' | 'matches' | 'too_few' | 'empty' | 'untestable';

export type SampleRatioVariant = {
  variantKey: string;
  allocationBasisPoints: number;
  observed: number;
  /** The observed total split by allocation. */
  expected: number;
};

export type SampleRatioCheck = {
  variants: SampleRatioVariant[];
  observedTotal: number;
  /** Pearson's Σ (observed − expected)² / expected; null when no test ran. */
  statistic: number | null;
  degreesOfFreedom: number;
  pValue: number | null;
  verdict: SampleRatioVerdict;
};

/**
 * Pearson's chi-square goodness of fit of the observed counts to the
 * allocation. Skewed below p 0.01; `too_few` when an expected count is under
 * 5, where the approximation does not hold; skewed outright when an arm
 * allocated nothing has viewers.
 */
export function checkSampleRatio(
  variants: ReadonlyArray<{ variantKey: string; allocationBasisPoints: number; observed: number }>,
): SampleRatioCheck {
  const observedTotal = variants.reduce((sum, variant) => sum + variant.observed, 0);
  const allocationTotal = variants.reduce((sum, variant) => sum + Math.max(0, variant.allocationBasisPoints), 0);
  const withExpected = variants.map((variant) => ({
    ...variant,
    expected: allocationTotal > 0 ? (observedTotal * Math.max(0, variant.allocationBasisPoints)) / allocationTotal : 0,
  }));
  const tested = withExpected.filter((variant) => variant.expected > 0);
  const untested = { variants: withExpected, observedTotal, statistic: null, pValue: null };
  if (observedTotal === 0) return { ...untested, degreesOfFreedom: 0, verdict: 'empty' };
  if (withExpected.some((variant) => variant.expected === 0 && variant.observed > 0)) {
    return { ...untested, degreesOfFreedom: 0, verdict: 'skewed' };
  }
  if (tested.length < 2) return { ...untested, degreesOfFreedom: 0, verdict: 'untestable' };

  const statistic = tested.reduce(
    (sum, variant) => sum + ((variant.observed - variant.expected) ** 2) / variant.expected,
    0,
  );
  const degreesOfFreedom = tested.length - 1;
  const pValue = chiSquareSurvival(statistic, degreesOfFreedom);
  const verdict: SampleRatioVerdict = tested.some((variant) => variant.expected < SAMPLE_RATIO_MIN_EXPECTED)
    ? 'too_few'
    : pValue < SAMPLE_RATIO_P_THRESHOLD ? 'skewed' : 'matches';
  return { variants: withExpected, observedTotal, statistic, degreesOfFreedom, pValue, verdict };
}

export function sampleRatioVerdictText(check: SampleRatioCheck, subject: 'assignment' | 'exposure'): string {
  switch (check.verdict) {
    case 'skewed':
      return `${subject} is skewed — do not read this experiment.`;
    case 'matches':
      return `${subject} matches the allocation (p ≥ ${SAMPLE_RATIO_P_THRESHOLD}).`;
    case 'too_few':
      return `too few viewers to test ${subject}: an expected count is under ${SAMPLE_RATIO_MIN_EXPECTED}. `
        + 'Check again later.';
    case 'empty':
      return subject === 'assignment'
        ? 'no viewer is assigned yet: nothing to check.'
        : 'no assigned viewer has been served yet: nothing to check.';
    case 'untestable':
      return `fewer than two variants have an allocation: there is no ${subject} ratio to check.`;
  }
}

function formatPValue(pValue: number): string {
  return pValue < 0.0001 ? 'p < 0.0001' : `p = ${pValue.toFixed(4)}`;
}

function describeChiSquare(check: SampleRatioCheck): string {
  if (check.statistic === null || check.pValue === null) return `${check.observedTotal} viewers, no test.`;
  const freedom = `${check.degreesOfFreedom} ${check.degreesOfFreedom === 1 ? 'degree' : 'degrees'} of freedom`;
  return `chi-square ${check.statistic.toFixed(2)} with ${freedom}, ${formatPValue(check.pValue)}.`;
}

export type ExperimentAssignmentCount = {
  variantKey: string;
  allocationBasisPoints: number;
  assignedViewers: number;
  exposedViewers: number;
};

const ASSIGNMENT_COUNTS_SOURCE = 'feed_experiment_assignment_counts';

function normalizeAssignmentCount(value: unknown): ExperimentAssignmentCount {
  const row = asRow(value, ASSIGNMENT_COUNTS_SOURCE);
  return {
    variantKey: requiredString(row, 'variant_key', ASSIGNMENT_COUNTS_SOURCE),
    allocationBasisPoints: requiredWholeNumber(row, 'allocation_basis_points', ASSIGNMENT_COUNTS_SOURCE),
    assignedViewers: sectionCount(row, 'assigned_viewers', ASSIGNMENT_COUNTS_SOURCE),
    exposedViewers: sectionCount(row, 'exposed_viewers', ASSIGNMENT_COUNTS_SOURCE),
  };
}

export function formatSampleRatio(
  experiment: Pick<FeedExperiment, 'experimentKey' | 'status'>,
  counts: readonly ExperimentAssignmentCount[],
): string[] {
  const lines = [
    `Sample ratio check: experiment ${experiment.experimentKey} (${experiment.status}), `
    + `from ${ASSIGNMENT_COUNTS_SOURCE}.`,
  ];
  if (counts.length === 0) {
    lines.push(`  ${ASSIGNMENT_COUNTS_SOURCE} returned no variants.`);
    return lines;
  }
  const check = (pick: (count: ExperimentAssignmentCount) => number) => checkSampleRatio(counts.map((count) => ({
    variantKey: count.variantKey,
    allocationBasisPoints: count.allocationBasisPoints,
    observed: pick(count),
  })));
  const assignment = check((count) => count.assignedViewers);
  const exposure = check((count) => count.exposedViewers);
  lines.push(...alignColumns([
    ['  VARIANT', 'ALLOCATION', 'ASSIGNED', 'EXPECTED', 'EXPOSED', 'EXPECTED'],
    ...counts.map((count, index) => [
      `  ${count.variantKey}`,
      formatBasisPoints(count.allocationBasisPoints),
      String(count.assignedViewers),
      assignment.variants[index].expected.toFixed(1),
      String(count.exposedViewers),
      exposure.variants[index].expected.toFixed(1),
    ]),
  ], ['left', 'right', 'right', 'right', 'right', 'right']));
  lines.push(
    `  Assignment (viewers assigned a variant): ${describeChiSquare(assignment)}`,
    `  Verdict: ${sampleRatioVerdictText(assignment, 'assignment')}`,
    `  Exposure (assigned viewers served at least once): ${describeChiSquare(exposure)}`,
    `  Verdict: ${sampleRatioVerdictText(exposure, 'exposure')}`,
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Experiments

export type CreateFeedExperimentPayload = {
  p_experiment: { experiment_key: string; traffic_basis_points: number; status: 'running' };
  p_variants: Array<{
    variant_key: 'control' | 'treatment';
    algorithm_version_id: string;
    allocation_basis_points: number;
  }>;
};

function assertBasisPoints(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > BASIS_POINTS_TOTAL) {
    throw new FeedAlgorithmUsageError(
      `${name} must be a whole number from 1 to ${BASIS_POINTS_TOTAL}.`,
    );
  }
}

/** The `create_feed_experiment` arguments: control gets 10000 − treatment. */
export function buildCreateExperimentPayload(input: {
  experimentKey: string;
  trafficBasisPoints: number;
  treatmentBasisPoints: number;
  controlVersionId: string;
  treatmentVersionId: string;
}): CreateFeedExperimentPayload {
  assertBasisPoints(input.trafficBasisPoints, '--traffic-bps');
  assertBasisPoints(input.treatmentBasisPoints, '--treatment-bps');
  return {
    p_experiment: {
      experiment_key: input.experimentKey,
      traffic_basis_points: input.trafficBasisPoints,
      status: 'running',
    },
    p_variants: [
      {
        variant_key: 'control',
        algorithm_version_id: input.controlVersionId,
        allocation_basis_points: BASIS_POINTS_TOTAL - input.treatmentBasisPoints,
      },
      {
        variant_key: 'treatment',
        algorithm_version_id: input.treatmentVersionId,
        allocation_basis_points: input.treatmentBasisPoints,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Commands

export type FeedAlgorithmCliOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
};

export type FeedAlgorithmCliDeps = {
  /** Injected in tests; otherwise a service-role client is built from `environment`. */
  client?: SupabaseClient;
  environment?: NodeJS.ProcessEnv;
  output?: FeedAlgorithmCliOutput;
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

function logLines(output: FeedAlgorithmCliOutput, lines: readonly string[]): void {
  for (const line of lines) output.log(line);
}

function printResult(output: FeedAlgorithmCliOutput, rpcName: string, result: unknown): void {
  output.log(`Applied with ${rpcName}:`);
  output.log(JSON.stringify(result ?? null, null, 2));
}

async function runList(client: SupabaseClient, output: FeedAlgorithmCliOutput) {
  const [versions, experiments] = await Promise.all([
    loadVersions(client),
    loadExperiments(client),
  ]);
  logLines(output, formatFeedAlgorithmList(versions, experiments));
}

async function runScorecard(
  client: SupabaseClient,
  command: Extract<FeedAlgorithmCommand, { command: 'scorecard' }>,
  output: FeedAlgorithmCliOutput,
) {
  const [rows, versions, experiments, viewers, positions, formats] = await Promise.all([
    callRpc(client, 'feed_algorithm_scorecard', { p_days: command.days }),
    loadVersions(client),
    loadExperiments(client),
    loadScorecardSection(client, 'feed_scorecard_viewers', command.days),
    loadScorecardSection(client, 'feed_scorecard_positions', command.days),
    loadScorecardSection(client, 'feed_scorecard_formats', command.days),
  ]);
  if (rows !== null && !Array.isArray(rows)) {
    throw new Error('feed_algorithm_scorecard did not return rows.');
  }
  const lines = buildScorecardLines(rows ?? [], command.by, versions, experiments);
  const sections = formatScorecardV2({
    feed_scorecard_viewers: viewers,
    feed_scorecard_positions: positions,
    feed_scorecard_formats: formats,
  }, command.days, versions, experiments);
  logLines(output, [...formatScorecard(lines, command.days, command.by), ...sections]);
}

async function runActivate(
  client: SupabaseClient,
  command: Extract<FeedAlgorithmCommand, { command: 'activate' }>,
  output: FeedAlgorithmCliOutput,
) {
  const versions = await loadVersions(client);
  const label = feedAlgorithmVersionLabel(command);
  const target = versions.find((version) => (
    version.algorithmKey === command.algorithmKey && version.version === command.version
  ));
  if (!target) throw new Error(`No feed algorithm version ${label}. Run list to see the versions.`);
  if (target.status === 'active') throw new Error(`${label} is already active.`);
  if (!ACTIVATABLE_VERSION_STATUSES.includes(target.status)) {
    throw new Error(`${label} is ${target.status}; only a draft, shadow or retired version can be activated.`);
  }

  const current = versions.find((version) => (
    version.algorithmKey === command.algorithmKey && version.status === 'active'
  ));
  output.log(`Activate ${label}`);
  logLines(output, alignColumns([
    ...(current ? [[`  ${feedAlgorithmVersionLabel(current)}`, 'active → retired', current.id]] : []),
    [`  ${label}`, `${target.status} → active`, target.id],
  ]));
  if (!current) output.log(`  No ${command.algorithmKey} version is active today.`);

  if (!command.apply) {
    output.log(dryRunNotice('activate_feed_algorithm_version'));
    return;
  }
  const result = await callRpc(client, 'activate_feed_algorithm_version', { p_version_id: target.id });
  printResult(output, 'activate_feed_algorithm_version', result);
}

function resolveExperimentVersion(
  versions: readonly FeedAlgorithmVersion[],
  algorithmKey: string,
  version: number,
  arm: 'control' | 'treatment',
): FeedAlgorithmVersion {
  const label = feedAlgorithmVersionLabel({ algorithmKey, version });
  const row = versions.find((candidate) => (
    candidate.algorithmKey === algorithmKey && candidate.version === version
  ));
  if (!row) throw new Error(`No feed algorithm version ${label} for the ${arm}. Run list to see the versions.`);
  if (!EXPERIMENT_VERSION_STATUSES.includes(row.status)) {
    throw new Error(
      `${label} (${arm}) is ${row.status}; create_feed_experiment takes only an active or shadow version.`,
    );
  }
  return row;
}

async function runExperimentStart(
  client: SupabaseClient,
  command: Extract<FeedAlgorithmCommand, { command: 'experiment-start' }>,
  output: FeedAlgorithmCliOutput,
) {
  const [versions, experiments] = await Promise.all([
    loadVersions(client),
    loadExperiments(client),
  ]);
  const control = resolveExperimentVersion(versions, command.algorithmKey, command.controlVersion, 'control');
  const treatment = resolveExperimentVersion(
    versions, command.algorithmKey, command.treatmentVersion, 'treatment',
  );
  const existing = experiments.find((experiment) => experiment.experimentKey === command.experimentKey);
  if (existing) {
    throw new Error(
      `Experiment ${command.experimentKey} already exists (${existing.status}). Experiment keys are unique; choose another --key.`,
    );
  }
  // src/lib/feed-experiments.ts enrols viewers only in the oldest running
  // experiment, so a second one would run for days without a single viewer.
  const running = experiments.find((experiment) => experiment.status === 'running');
  if (running) {
    throw new Error(
      `Experiment ${running.experimentKey} is running, and the feed enrols viewers only in the oldest running experiment. `
      + `Stop it first: npm run ops:feed-algorithm -- experiment stop --key ${running.experimentKey}`,
    );
  }

  const payload = buildCreateExperimentPayload({
    experimentKey: command.experimentKey,
    trafficBasisPoints: command.trafficBasisPoints,
    treatmentBasisPoints: command.treatmentBasisPoints,
    controlVersionId: control.id,
    treatmentVersionId: treatment.id,
  });
  const [controlVariant, treatmentVariant] = payload.p_variants;
  output.log(`Start experiment ${command.experimentKey}`);
  logLines(output, alignColumns([
    ['  traffic', `${formatBasisPoints(command.trafficBasisPoints)} of viewers enrolled`],
    ['  control', `${feedAlgorithmVersionLabel(control)} (${control.status})`,
      `${formatBasisPoints(controlVariant.allocation_basis_points)} of enrolled viewers`],
    ['  treatment', `${feedAlgorithmVersionLabel(treatment)} (${treatment.status})`,
      `${formatBasisPoints(treatmentVariant.allocation_basis_points)} of enrolled viewers`],
  ]));
  if (control.id === treatment.id) {
    output.log('  Control and treatment are the same version: an A/A run.');
  }
  const active = versions.find((version) => (
    version.algorithmKey === command.algorithmKey && version.status === 'active'
  ));
  if (command.trafficBasisPoints < BASIS_POINTS_TOTAL && active) {
    output.log(`  Viewers outside the experiment keep ${feedAlgorithmVersionLabel(active)}, the active version.`);
  }

  if (!command.apply) {
    output.log(dryRunNotice('create_feed_experiment'));
    return;
  }
  const result = await callRpc(client, 'create_feed_experiment', payload);
  printResult(output, 'create_feed_experiment', result);
}

async function runExperimentStop(
  client: SupabaseClient,
  command: Extract<FeedAlgorithmCommand, { command: 'experiment-stop' }>,
  output: FeedAlgorithmCliOutput,
) {
  const [versions, experiments] = await Promise.all([
    loadVersions(client),
    loadExperiments(client),
  ]);
  const experiment = experiments.find((candidate) => candidate.experimentKey === command.experimentKey);
  if (!experiment) {
    throw new Error(`No feed experiment ${command.experimentKey}. Run list to see the experiments.`);
  }
  if (FINISHED_EXPERIMENT_STATUSES.includes(experiment.status)) {
    throw new Error(`Experiment ${experiment.experimentKey} is already ${experiment.status}.`);
  }
  if (experiment.status === command.status) {
    throw new Error(`Experiment ${experiment.experimentKey} is already ${command.status}.`);
  }

  const versionsById = new Map(versions.map((version) => [version.id, version]));
  output.log(`Stop experiment ${experiment.experimentKey}`);
  logLines(output, alignColumns([
    ['  status', `${experiment.status} → ${command.status}`],
    ...experiment.variants.map((variant) => {
      const version = versionsById.get(variant.algorithmVersionId);
      return [
        `  ${variant.variantKey}`,
        version ? feedAlgorithmVersionLabel(version) : `version ${variant.algorithmVersionId}`,
        formatBasisPoints(variant.allocationBasisPoints),
      ];
    }),
  ]));
  const armKey = experiment.variants
    .map((variant) => versionsById.get(variant.algorithmVersionId)?.algorithmKey)
    .find((key) => key !== undefined) ?? DEFAULT_ALGORITHM_KEY;
  const active = versions.find((version) => version.algorithmKey === armKey && version.status === 'active');
  if (active) {
    output.log(`  Afterwards every viewer gets ${feedAlgorithmVersionLabel(active)}, the active version.`);
  }

  if (!command.apply) {
    output.log(dryRunNotice('set_feed_experiment_status'));
    return;
  }
  const result = await callRpc(client, 'set_feed_experiment_status', {
    p_experiment_id: experiment.id,
    p_status: command.status,
  });
  printResult(output, 'set_feed_experiment_status', result);
}

async function runExperimentSrm(
  client: SupabaseClient,
  command: Extract<FeedAlgorithmCommand, { command: 'experiment-srm' }>,
  output: FeedAlgorithmCliOutput,
) {
  const experiments = await loadExperiments(client);
  const experiment = experiments.find((candidate) => candidate.experimentKey === command.experimentKey);
  if (!experiment) {
    throw new Error(`No feed experiment ${command.experimentKey}. Run list to see the experiments.`);
  }
  const rows = await callRpc(
    client,
    'feed_experiment_assignment_counts',
    { p_experiment_key: command.experimentKey },
    'v4',
  );
  if (rows !== null && !Array.isArray(rows)) {
    throw new Error('feed_experiment_assignment_counts did not return rows.');
  }
  const counts = (rows ?? [])
    .map((row: unknown) => normalizeAssignmentCount(row))
    // Same order the feed buckets them in (src/lib/feed-experiments.ts).
    .sort((left, right) => left.variantKey.localeCompare(right.variantKey));
  logLines(output, formatSampleRatio(experiment, counts));
}

/**
 * Runs one command and resolves to the process exit code: 0 on success, 1 on
 * a usage error (printed with the usage), a refusal or a database error.
 */
export async function runFeedAlgorithmCli(
  argv: readonly string[],
  deps: FeedAlgorithmCliDeps = {},
): Promise<number> {
  const output = deps.output ?? {
    log: (line: string) => console.log(line),
    error: (line: string) => console.error(line),
  };

  let command: FeedAlgorithmCommand;
  try {
    command = parseFeedAlgorithmArgs(argv);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    output.error('');
    output.error(FEED_ALGORITHM_USAGE);
    return 1;
  }
  if (command.command === 'help') {
    output.log(FEED_ALGORITHM_USAGE);
    return 0;
  }

  try {
    const client = deps.client ?? createServiceRoleClient(deps.environment ?? process.env);
    switch (command.command) {
      case 'list':
        await runList(client, output);
        break;
      case 'scorecard':
        await runScorecard(client, command, output);
        break;
      case 'activate':
        await runActivate(client, command, output);
        break;
      case 'experiment-start':
        await runExperimentStart(client, command, output);
        break;
      case 'experiment-stop':
        await runExperimentStop(client, command, output);
        break;
      case 'experiment-srm':
        await runExperimentSrm(client, command, output);
        break;
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
  runFeedAlgorithmCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
