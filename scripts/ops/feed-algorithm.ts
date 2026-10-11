/**
 * For You ranking operations: list the algorithm versions and experiments,
 * read the scorecard, activate a version, start or stop an experiment.
 *
 * Service role only. `list` and `scorecard` only read. `activate` and
 * `experiment start|stop` print their plan and change nothing without
 * `--apply`; each write is one service-role RPC (plan
 * docs/plans/feed-algorithm-v3-x-adoption-2026-10-11.md §2.4–§2.6), and the
 * CLI refuses up front what those RPCs would refuse. Nothing here prints the
 * service-role key or the database URL.
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

/** `activate_feed_algorithm_version` takes only these targets (plan §2.4). */
export const ACTIVATABLE_VERSION_STATUSES: readonly string[] = ['draft', 'shadow'];
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

Environment:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY

Notes:
  - list and scorecard only read. activate and experiment print their plan and change nothing without --apply.
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
    };

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
      throw new FeedAlgorithmUsageError(
        subcommand === undefined
          ? 'Missing experiment command: start or stop.'
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

function describeError(error: DatabaseError): string {
  const message = error.message || 'unknown error';
  if (error.code === 'PGRST202') {
    return `${message} (is the feed ranking v3 migration applied?)`;
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
): Promise<unknown> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${describeError(error)}`);
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
  unit: 'percent' | 'per_1k';
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

export function computeScorecardRates(counts: ScorecardCounts): ScorecardRate[] {
  const percent = (label: string, numerator: number, denominator: number): ScorecardRate => ({
    label, numerator, denominator, unit: 'percent', value: rateOf(numerator, denominator, 100),
  });
  const perThousand = (label: string, numerator: number, denominator: number): ScorecardRate => ({
    label, numerator, denominator, unit: 'per_1k', value: rateOf(numerator, denominator, 1000),
  });
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
  return rate.unit === 'percent' ? `${rate.value.toFixed(1)}%` : rate.value.toFixed(1);
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
  const versionOrder = new Map(versions.map((version, index) => [version.id, index]));
  const versionLabels = versionLabelsById(versions);
  const armLabels = new Map<string, string>();
  for (const experiment of experiments) {
    for (const variant of experiment.variants) {
      armLabels.set(variant.id, `${experiment.experimentKey}/${variant.variantKey}`);
    }
  }

  const arms = new Map<string, ScorecardRow[]>();
  for (const row of rawRows.map((value) => normalizeScorecardRow(value))) {
    const key = `${row.algorithmVersionId ?? ''}|${row.experimentVariantId ?? ''}`;
    const members = arms.get(key);
    if (members) members.push(row);
    else arms.set(key, [row]);
  }

  const lines: Array<{ line: ScorecardLine; order: number }> = [];
  for (const members of arms.values()) {
    const head = members[0];
    const joinedLabel = head.algorithmVersionId ? versionLabels.get(head.algorithmVersionId) : undefined;
    const describe = (rows: readonly ScorecardRow[], source: string | null) => {
      const counts = combineScorecardRows(rows);
      lines.push({
        order: (head.algorithmVersionId ? versionOrder.get(head.algorithmVersionId) : undefined)
          ?? Number.MAX_SAFE_INTEGER,
        line: {
          versionLabel: joinedLabel ?? head.algorithmLabel ?? head.algorithmVersionId ?? 'unknown version',
          armLabel: head.experimentVariantId === null
            ? 'no experiment'
            : armLabels.get(head.experimentVariantId)
              ?? `variant ${head.variantKey ?? head.experimentVariantId}`,
          inExperiment: head.experimentVariantId !== null,
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
  const [rows, versions, experiments] = await Promise.all([
    callRpc(client, 'feed_algorithm_scorecard', { p_days: command.days }),
    loadVersions(client),
    loadExperiments(client),
  ]);
  if (rows !== null && !Array.isArray(rows)) {
    throw new Error('feed_algorithm_scorecard did not return rows.');
  }
  const lines = buildScorecardLines(rows ?? [], command.by, versions, experiments);
  logLines(output, formatScorecard(lines, command.days, command.by));
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
  if (target.status === 'retired') {
    throw new Error(
      `${label} is retired, and activate_feed_algorithm_version takes only a draft or shadow version. `
      + `To roll back to it, follow "Rollback" in ${RUNBOOK_PATH}.`,
    );
  }
  if (!ACTIVATABLE_VERSION_STATUSES.includes(target.status)) {
    throw new Error(`${label} is ${target.status}; only a draft or shadow version can be activated.`);
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
