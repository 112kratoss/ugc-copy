import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  FEED_ALGORITHM_USAGE,
  FeedAlgorithmUsageError,
  buildCreateExperimentPayload,
  buildScorecardLines,
  computeScorecardRates,
  formatScorecard,
  formatScorecardRate,
  parseFeedAlgorithmArgs,
  runFeedAlgorithmCli,
  type FeedAlgorithmVersion,
  type FeedExperiment,
} from '../../scripts/ops/feed-algorithm';

type Row = Record<string, unknown>;
type QueryError = { message: string; code?: string };
type QueryResult = { data: unknown; error: QueryError | null };
type OrderedQuery = PromiseLike<QueryResult> & {
  order: (column: string, options?: { ascending?: boolean }) => OrderedQuery;
};

const V1 = '00000000-0000-4000-8000-000000000001';
const V2 = '00000000-0000-4000-8000-000000000002';
const V3 = '00000000-0000-4000-8000-000000000003';
const V4 = '00000000-0000-4000-8000-000000000004';

function versionRow(id: string, version: number, status: string, extra: Row = {}): Row {
  return {
    id,
    algorithm_key: 'for-you-rules',
    version,
    status,
    activated_at: status === 'active' ? '2026-07-11T06:40:36.000Z' : null,
    retired_at: null,
    description: `Rules v${version}`,
    ...extra,
  };
}

const VERSIONS: Row[] = [
  versionRow(V1, 1, 'active'),
  versionRow(V2, 2, 'shadow'),
  versionRow(V3, 3, 'shadow', { description: 'X-adoption: author-diversity decay, cold-start slot.' }),
  versionRow(V4, 4, 'draft'),
];

// v3 promoted, v1 retired: what the table looks like after `activate --version 3`.
const AFTER_V3_ACTIVATION: Row[] = [
  versionRow(V1, 1, 'retired', {
    activated_at: '2026-07-11T06:40:36.000Z',
    retired_at: '2026-10-20T09:00:00.000Z',
  }),
  versionRow(V2, 2, 'shadow'),
  versionRow(V3, 3, 'active', { activated_at: '2026-10-20T09:00:00.000Z' }),
];

function experimentRow(key: string, status: string, extra: Row = {}): Row {
  return {
    id: `experiment-${key}`,
    experiment_key: key,
    status,
    traffic_basis_points: 10000,
    starts_at: '2026-10-12T08:00:00.000Z',
    ends_at: null,
    created_at: '2026-10-12T08:00:00.000Z',
    // Treatment first on purpose: the CLI lists variants in bucket order.
    feed_experiment_variants: [
      { id: `${key}-treatment`, variant_key: 'treatment', algorithm_version_id: V3, allocation_basis_points: 5000 },
      { id: `${key}-control`, variant_key: 'control', algorithm_version_id: V1, allocation_basis_points: 5000 },
    ],
    ...extra,
  };
}

function scorecardRow(overrides: Row): Row {
  return {
    algorithm_version_id: V1,
    algorithm_label: 'label-from-rpc',
    experiment_variant_id: null,
    variant_key: null,
    candidate_source: 'trending',
    served: 0,
    rendered: 0,
    qualified: 0,
    meaningful: 0,
    quick_skips: 0,
    negatives: 0,
    saves: 0,
    remix_starts: 0,
    distinct_viewers: 0,
    repeat_exposures: 0,
    avg_position: null,
    ...overrides,
  };
}

// v1, outside any experiment, split over two candidate sources.
const V1_TRENDING = scorecardRow({
  candidate_source: 'trending', served: 600, rendered: 500, qualified: 300, meaningful: 25,
  quick_skips: 50, negatives: 1, saves: 3, remix_starts: 10, distinct_viewers: 10,
  repeat_exposures: 30, avg_position: 10,
});
const V1_FRESH = scorecardRow({
  candidate_source: 'fresh', served: 400, rendered: 300, qualified: 200, meaningful: 15,
  quick_skips: 30, negatives: 1, saves: 1, remix_starts: 6, distinct_viewers: 8,
  repeat_exposures: 20, avg_position: 20,
});
// v3's treatment arm: served, never rendered.
const V3_TREATMENT_COLD = scorecardRow({
  algorithm_version_id: V3, experiment_variant_id: 'v3-vs-v1-treatment', variant_key: 'treatment',
  candidate_source: 'cold', served: 5, distinct_viewers: 2, avg_position: 5.5,
});

type FakeSeed = {
  versions?: Row[];
  experiments?: Row[];
  scorecard?: unknown;
  rpcResults?: Record<string, QueryResult>;
  tableErrors?: Record<string, QueryError>;
};

function createFakeClient(seed: FakeSeed = {}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const selects: Array<{ table: string; columns: string; orders: string[] }> = [];

  function orderedQuery(result: QueryResult, orders: string[]): OrderedQuery {
    const promise = Promise.resolve(result);
    return {
      order: (column) => {
        orders.push(column);
        return orderedQuery(result, orders);
      },
      then: promise.then.bind(promise),
    };
  }

  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const orders: string[] = [];
          selects.push({ table, columns, orders });
          const error = seed.tableErrors?.[table] ?? null;
          if (table === 'feed_algorithm_versions') {
            return orderedQuery({ data: error ? null : (seed.versions ?? VERSIONS), error }, orders);
          }
          if (table === 'feed_experiments') {
            return orderedQuery({ data: error ? null : (seed.experiments ?? []), error }, orders);
          }
          throw new Error(`Unexpected table: ${table}`);
        },
      };
    },
    async rpc(name: string, args: unknown): Promise<QueryResult> {
      rpcCalls.push({ name, args });
      const preset = seed.rpcResults?.[name];
      if (preset) return preset;
      if (name === 'feed_algorithm_scorecard') return { data: seed.scorecard ?? [], error: null };
      return { data: { rpc: name }, error: null };
    },
  };

  return { client: client as unknown as SupabaseClient, rpcCalls, selects };
}

async function run(argv: string[], seed?: FakeSeed) {
  const fake = createFakeClient(seed);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runFeedAlgorithmCli(argv, {
    client: fake.client,
    output: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
  });
  return {
    exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    rpcCalls: fake.rpcCalls,
    selects: fake.selects,
  };
}

function versionsOf(rows: Row[]): FeedAlgorithmVersion[] {
  return rows.map((row) => ({
    id: row.id as string,
    algorithmKey: row.algorithm_key as string,
    version: row.version as number,
    status: row.status as string,
    activatedAt: row.activated_at as string | null,
    retiredAt: row.retired_at as string | null,
    description: row.description as string,
  }));
}

const RUNNING_EXPERIMENT: FeedExperiment = {
  id: 'experiment-v3-vs-v1',
  experimentKey: 'v3-vs-v1',
  status: 'running',
  trafficBasisPoints: 10000,
  startsAt: null,
  endsAt: null,
  variants: [
    { id: 'v3-vs-v1-control', variantKey: 'control', algorithmVersionId: V1, allocationBasisPoints: 5000 },
    { id: 'v3-vs-v1-treatment', variantKey: 'treatment', algorithmVersionId: V3, allocationBasisPoints: 5000 },
  ],
};

describe('parseFeedAlgorithmArgs', () => {
  it('parses list, and scorecard with its defaults and options', () => {
    expect(parseFeedAlgorithmArgs(['list'])).toEqual({ command: 'list' });
    expect(parseFeedAlgorithmArgs(['scorecard'])).toEqual({ command: 'scorecard', days: 7, by: 'version' });
    expect(parseFeedAlgorithmArgs(['scorecard', '--days', '14', '--by', 'source'])).toEqual({
      command: 'scorecard',
      days: 14,
      by: 'source',
    });
  });

  it('parses activate, with --apply off unless given', () => {
    expect(parseFeedAlgorithmArgs(['activate', '--key', 'for-you-rules', '--version', '3'])).toEqual({
      command: 'activate',
      algorithmKey: 'for-you-rules',
      version: 3,
      apply: false,
    });
    expect(parseFeedAlgorithmArgs([
      'activate', '--apply', '--version', '3', '--key', 'for-you-rules',
    ])).toEqual({ command: 'activate', algorithmKey: 'for-you-rules', version: 3, apply: true });
  });

  it('parses experiment start with its defaults and with every option', () => {
    expect(parseFeedAlgorithmArgs([
      'experiment', 'start', '--key', 'v3-vs-v1', '--control', '1', '--treatment', '3',
    ])).toEqual({
      command: 'experiment-start',
      experimentKey: 'v3-vs-v1',
      algorithmKey: 'for-you-rules',
      controlVersion: 1,
      treatmentVersion: 3,
      trafficBasisPoints: 10000,
      treatmentBasisPoints: 5000,
      apply: false,
    });
    expect(parseFeedAlgorithmArgs([
      'experiment', 'start', '--key', 'aa-run', '--control', '2', '--treatment', '2',
      '--algorithm-key', 'for-you-rules', '--traffic-bps', '2500', '--treatment-bps', '3000', '--apply',
    ])).toEqual({
      command: 'experiment-start',
      experimentKey: 'aa-run',
      algorithmKey: 'for-you-rules',
      controlVersion: 2,
      treatmentVersion: 2,
      trafficBasisPoints: 2500,
      treatmentBasisPoints: 3000,
      apply: true,
    });
  });

  it('parses experiment stop with completed as the default status', () => {
    expect(parseFeedAlgorithmArgs(['experiment', 'stop', '--key', 'v3-vs-v1'])).toEqual({
      command: 'experiment-stop',
      experimentKey: 'v3-vs-v1',
      status: 'completed',
      apply: false,
    });
    expect(parseFeedAlgorithmArgs([
      'experiment', 'stop', '--key', 'v3-vs-v1', '--status', 'cancelled', '--apply',
    ])).toEqual({ command: 'experiment-stop', experimentKey: 'v3-vs-v1', status: 'cancelled', apply: true });
  });

  it('reads help anywhere on the line', () => {
    expect(parseFeedAlgorithmArgs(['help'])).toEqual({ command: 'help' });
    expect(parseFeedAlgorithmArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseFeedAlgorithmArgs(['experiment', 'start', '--help'])).toEqual({ command: 'help' });
  });

  const start = ['experiment', 'start', '--key', 'k', '--control', '1', '--treatment', '3'];
  it.each<[string[], RegExp]>([
    [[], /Missing command/],
    [['promote'], /Unknown command: promote/],
    [['experiment'], /Missing experiment command: start or stop/],
    [['experiment', 'restart', '--key', 'k'], /Unknown experiment command: restart/],
    [['list', '--apply'], /Unknown option: --apply/],
    [['scorecard', '--apply'], /Unknown option: --apply/],
    [['scorecard', '--days', '0'], /--days must be a whole number from 1 to 30/],
    [['scorecard', '--days', '31'], /--days must be a whole number from 1 to 30/],
    [['scorecard', '--days', '7.5'], /--days must be a whole number/],
    [['scorecard', '--by', 'creator'], /--by must be version or source/],
    [['activate', '--key', 'for-you-rules'], /--version is required/],
    [['activate', '--version', '3'], /--key is required/],
    [['activate', '--key', '--version', '3'], /Missing value for --key/],
    [['activate', '--key', 'for-you-rules', '--version', '0'], /--version must be a whole number/],
    [['activate', '--key', 'for-you-rules', '--version', 'v3'], /--version must be a whole number/],
    [['activate', '--key', 'for-you-rules', '--version', '3', '--aply'], /Unknown option: --aply/],
    [['activate', '--key', 'a', '--key', 'b', '--version', '3'], /Duplicate option: --key/],
    [['activate', 'for-you-rules'], /Unexpected argument: for-you-rules/],
    [['experiment', 'start', '--key', 'k', '--treatment', '3'], /--control is required/],
    [['experiment', 'start', '--key', 'k', '--control', '1'], /--treatment is required/],
    [['experiment', 'start', '--control', '1', '--treatment', '3'], /--key is required/],
    [[...start, '--treatment-bps', '0'], /--treatment-bps must be a whole number from 1 to 10000/],
    [[...start, '--treatment-bps', '10001'], /--treatment-bps must be a whole number from 1 to 10000/],
    [[...start, '--treatment-bps', '50%'], /--treatment-bps must be a whole number from 1 to 10000/],
    [[...start, '--traffic-bps', '0'], /--traffic-bps must be a whole number from 1 to 10000/],
    [[...start, '--traffic-bps', '-5'], /--traffic-bps must be a whole number from 1 to 10000/],
    [[...start, '--traffic-bps', '10001'], /--traffic-bps must be a whole number from 1 to 10000/],
    [['experiment', 'start', '--key', 'k'.repeat(101), '--control', '1', '--treatment', '3'], /at most 100 characters/],
    [['experiment', 'stop'], /--key is required/],
    [['experiment', 'stop', '--key', 'k', '--status', 'running'], /--status must be completed, cancelled or paused/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseFeedAlgorithmArgs(argv)).toThrow(FeedAlgorithmUsageError);
    expect(() => parseFeedAlgorithmArgs(argv)).toThrow(message);
  });
});

describe('runFeedAlgorithmCli: usage, environment and exit codes', () => {
  it('prints the usage and exits 1 for an unknown command, before building any client', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runFeedAlgorithmCli(['promote', '--key', 'for-you-rules'], {
      environment: { NODE_ENV: 'test' },
      output: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
    });
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('Unknown command: promote');
    expect(stderr.join('\n')).toContain(FEED_ALGORITHM_USAGE);
    expect(stderr.join('\n')).not.toContain('Missing SUPABASE_URL');
    expect(stdout).toEqual([]);
  });

  it('prints the usage and exits 1 when an argument is missing', async () => {
    const result = await run(['activate', '--key', 'for-you-rules']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--version is required.');
    expect(result.stderr).toContain('Usage:');
    expect(result.selects).toEqual([]);
    expect(result.rpcCalls).toEqual([]);
  });

  it('prints the usage and exits 0 for help', async () => {
    const result = await run(['help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(FEED_ALGORITHM_USAGE);
    expect(result.stderr).toBe('');
  });

  it('exits 1 without echoing the key when the environment is incomplete', async () => {
    const lines: string[] = [];
    const exitCode = await runFeedAlgorithmCli(['list'], {
      environment: { NODE_ENV: 'test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-value' },
      output: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    });
    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    expect(lines.join('\n')).not.toContain('service-role-test-value');
  });

  it('exits 1 with the database message when a read fails', async () => {
    const result = await run(['list'], {
      tableErrors: { feed_algorithm_versions: { message: 'permission denied for table', code: '42501' } },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Reading feed_algorithm_versions failed: permission denied for table (42501)');
  });
});

describe('list', () => {
  it('prints every version label with its status, then experiments with traffic, window and variants', async () => {
    const result = await run(['list'], {
      experiments: [experimentRow('v3-vs-v1', 'running', { traffic_basis_points: 2500 })],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/for-you-rules-v1\s+active\s+2026-07-11 06:40 UTC\s+–\s+Rules v1/);
    expect(result.stdout).toMatch(/for-you-rules-v2\s+shadow\s+–\s+–\s+Rules v2/);
    expect(result.stdout).toMatch(/for-you-rules-v3\s+shadow\s+–\s+–\s+X-adoption: author-diversity decay/);
    expect(result.stdout).toMatch(/for-you-rules-v4\s+draft/);
    expect(result.stdout).toContain(
      'v3-vs-v1  running  traffic 2500 bps (25.00%)  window 2026-10-12 08:00 UTC → no end',
    );
    expect(result.stdout).toMatch(/control\s+for-you-rules-v1\s+5000 bps \(50\.00%\)/);
    expect(result.stdout).toMatch(/treatment\s+for-you-rules-v3\s+5000 bps \(50\.00%\)/);
    expect(result.stdout.indexOf('    control')).toBeLessThan(result.stdout.indexOf('    treatment'));

    expect(result.selects).toEqual([
      {
        table: 'feed_algorithm_versions',
        columns: 'id, algorithm_key, version, status, activated_at, retired_at, description',
        orders: ['algorithm_key', 'version'],
      },
      {
        table: 'feed_experiments',
        columns: expect.stringContaining(
          'feed_experiment_variants(id, variant_key, algorithm_version_id, allocation_basis_points)',
        ),
        orders: ['created_at'],
      },
    ]);
    expect(result.rpcCalls).toEqual([]);
  });

  it('says when there are no experiments, and warns when two are running', async () => {
    const empty = await run(['list']);
    expect(empty.stdout).toContain('Feed experiments (feed_experiments)\n  none');

    const twoRunning = await run(['list'], {
      experiments: [experimentRow('first', 'running'), experimentRow('second', 'running')],
    });
    expect(twoRunning.stdout).toContain(
      'Note: 2 experiments are running; the feed enrols viewers only in the oldest running one inside its window (first).',
    );
  });
});

describe('scorecard', () => {
  it('derives every rate from its numerator and denominator', () => {
    const rates = computeScorecardRates({
      served: 1000, rendered: 800, qualified: 500, meaningful: 40, quickSkips: 80, negatives: 2,
      saves: 4, remixStarts: 16, distinctViewers: 18, repeatExposures: 50, avgPosition: 14,
    });
    expect(rates.map((rate) => [rate.label, rate.numerator, rate.denominator, rate.value])).toEqual([
      ['rendered / served', 800, 1000, 80],
      ['qualified / rendered', 500, 800, 62.5],
      ['meaningful / rendered', 40, 800, 5],
      ['quick skips / rendered', 80, 800, 10],
      ['negatives per 1k rendered', 2, 800, 2.5],
      ['saves per 1k rendered', 4, 800, 5],
      ['remix starts per 1k rendered', 16, 800, 20],
      ['repeat exposures / served', 50, 1000, 5],
    ]);
    expect(rates.map(formatScorecardRate)).toEqual([
      '80.0%', '62.5%', '5.0%', '10.0%', '2.5', '5.0', '20.0', '5.0%',
    ]);
  });

  it('prints – for a zero denominator instead of dividing', () => {
    const served = computeScorecardRates({
      served: 5, rendered: 0, qualified: 0, meaningful: 0, quickSkips: 0, negatives: 0,
      saves: 0, remixStarts: 0, distinctViewers: 2, repeatExposures: 0, avgPosition: null,
    });
    expect(served.map((rate) => rate.value)).toEqual([0, null, null, null, null, null, null, 0]);
    expect(served.map(formatScorecardRate)).toEqual(['0.0%', '–', '–', '–', '–', '–', '–', '0.0%']);

    const nothing = computeScorecardRates({
      served: 0, rendered: 0, qualified: 0, meaningful: 0, quickSkips: 0, negatives: 0,
      saves: 0, remixStarts: 0, distinctViewers: 0, repeatExposures: 0, avgPosition: null,
    });
    expect(nothing.every((rate) => rate.value === null && formatScorecardRate(rate) === '–')).toBe(true);
  });

  it('sums per-source rows per version, weights the mean position, and bounds distinct viewers', () => {
    const [line] = buildScorecardLines([V1_TRENDING, V1_FRESH], 'version', versionsOf(VERSIONS), []);
    expect(line).toMatchObject({
      versionLabel: 'for-you-rules-v1',
      armLabel: 'no experiment',
      source: null,
      distinctViewersExact: false,
      // At least the busiest source's 10, at most 10 + 8.
      distinctViewersLowerBound: 10,
      counts: {
        served: 1000, rendered: 800, qualified: 500, meaningful: 40, quickSkips: 80, negatives: 2,
        saves: 4, remixStarts: 16, distinctViewers: 18, repeatExposures: 50,
        // (10 × 600 + 20 × 400) / 1000
        avgPosition: 14,
      },
    });
  });

  it('prints one viewer count when only one source had viewers', () => {
    const empty = scorecardRow({ ...V3_TREATMENT_COLD, candidate_source: 'following', served: 1, distinct_viewers: 0 });
    const lines = buildScorecardLines([V3_TREATMENT_COLD, empty], 'version', versionsOf(VERSIONS), []);
    expect(lines[0].distinctViewersExact).toBe(false);
    expect(formatScorecard(lines, 7, 'version').join('\n')).toContain(
      '  served 6 · distinct viewers 2 · mean position 5.5',
    );
  });

  it('uses an all-sources total row when the function returns one, so distinct viewers stay exact', () => {
    const total = scorecardRow({
      candidate_source: null, served: 1000, rendered: 800, qualified: 500, distinct_viewers: 12, avg_position: 13.5,
    });
    const lines = buildScorecardLines([V1_TRENDING, total, V1_FRESH], 'version', versionsOf(VERSIONS), []);
    expect(lines).toHaveLength(1);
    expect(lines[0].distinctViewersExact).toBe(true);
    expect(lines[0].counts).toMatchObject({ served: 1000, distinctViewers: 12, avgPosition: 13.5 });

    const bySource = buildScorecardLines([V1_TRENDING, total, V1_FRESH], 'source', versionsOf(VERSIONS), []);
    expect(bySource.map((line) => line.source)).toEqual(['trending', 'fresh']);
  });

  it('splits by source, busiest source first, and labels experiment arms', () => {
    const lines = buildScorecardLines(
      [V1_FRESH, V3_TREATMENT_COLD, V1_TRENDING],
      'source',
      versionsOf(VERSIONS),
      [RUNNING_EXPERIMENT],
    );
    expect(lines.map((line) => [line.versionLabel, line.armLabel, line.source, line.counts.served])).toEqual([
      ['for-you-rules-v1', 'no experiment', 'trending', 600],
      ['for-you-rules-v1', 'no experiment', 'fresh', 400],
      ['for-you-rules-v3', 'v3-vs-v1/treatment', 'cold', 5],
    ]);
    expect(lines.every((line) => line.distinctViewersExact)).toBe(true);
  });

  it('joins the label from feed_algorithm_versions and falls back to the function label', () => {
    const unknown = scorecardRow({ algorithm_version_id: 'deleted-version', served: 1 });
    const lines = buildScorecardLines([V1_TRENDING, unknown], 'version', versionsOf(VERSIONS), []);
    expect(lines.map((line) => line.versionLabel)).toEqual(['for-you-rules-v1', 'label-from-rpc']);
  });

  it('fails loudly when a contract column is missing', () => {
    const row = scorecardRow({ served: 1 });
    delete row.quick_skips;
    expect(() => buildScorecardLines([row], 'version', [], [])).toThrow(
      'feed_algorithm_scorecard returned no quick_skips column.',
    );
  });

  it('calls feed_algorithm_scorecard with p_days and prints numerators, denominators and rates', async () => {
    const result = await run(['scorecard', '--days', '14'], {
      scorecard: [V1_TRENDING, V1_FRESH, V3_TREATMENT_COLD],
      experiments: [experimentRow('v3-vs-v1', 'running')],
    });

    expect(result.exitCode).toBe(0);
    expect(result.rpcCalls).toEqual([{ name: 'feed_algorithm_scorecard', args: { p_days: 14 } }]);
    expect(result.stdout).toContain('Feed scorecard: deliveries served in the last 14 days, by version.');
    expect(result.stdout).toContain('not a significance test');
    expect(result.stdout).toContain('for-you-rules-v1 · no experiment\n');
    expect(result.stdout).not.toContain('label-from-rpc');
    expect(result.stdout).toContain(
      'served 1000 · distinct viewers between 10 and 18 (sources overlap) · mean position 14.0',
    );
    expect(result.stdout).toMatch(/rendered \/ served\s+800 \/ 1000\s+80\.0%/);
    expect(result.stdout).toMatch(/qualified \/ rendered\s+500 \/ 800\s+62\.5%/);
    expect(result.stdout).toMatch(/negatives per 1k rendered\s+2 \/ 800\s+2\.5/);
    expect(result.stdout).toMatch(/repeat exposures \/ served\s+50 \/ 1000\s+5\.0%/);

    expect(result.stdout).toContain('for-you-rules-v3 · v3-vs-v1/treatment');
    expect(result.stdout).toContain('served 5 · distinct viewers 2 · mean position 5.5');
    expect(result.stdout).toMatch(/rendered \/ served\s+0 \/ 5\s+0\.0%/);
    expect(result.stdout).toMatch(/qualified \/ rendered\s+0 \/ 0\s+–/);
    expect(result.stdout).toMatch(/saves per 1k rendered\s+0 \/ 0\s+–/);
  });

  it('defaults to 7 days, names each source with --by source, and says when nothing was served', async () => {
    const bySource = await run(['scorecard', '--by', 'source'], { scorecard: [V1_TRENDING, V1_FRESH] });
    expect(bySource.rpcCalls).toEqual([{ name: 'feed_algorithm_scorecard', args: { p_days: 7 } }]);
    expect(bySource.stdout).toContain('for-you-rules-v1 · no experiment · source trending');
    expect(bySource.stdout).toContain('for-you-rules-v1 · no experiment · source fresh');

    const empty = await run(['scorecard', '--days', '1']);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain('No deliveries were served in the last 1 day.');
    expect(formatScorecard([], 7, 'version')).toContain('No deliveries were served in the last 7 days.');
  });

  it('exits 1 with a hint when the scorecard function does not exist yet', async () => {
    const result = await run(['scorecard'], {
      rpcResults: {
        feed_algorithm_scorecard: {
          data: null,
          error: { message: 'Could not find the function public.feed_algorithm_scorecard', code: 'PGRST202' },
        },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('is the feed ranking v3 migration applied?');
  });
});

describe('activate', () => {
  it('prints the swap and calls nothing without --apply', async () => {
    const result = await run(['activate', '--key', 'for-you-rules', '--version', '3']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Activate for-you-rules-v3');
    expect(result.stdout).toMatch(new RegExp(`for-you-rules-v1\\s+active → retired\\s+${V1}`));
    expect(result.stdout).toMatch(new RegExp(`for-you-rules-v3\\s+shadow → active\\s+${V3}`));
    expect(result.stdout).toContain(
      'Dry run: nothing was changed. Re-run with --apply to call activate_feed_algorithm_version.',
    );
    expect(result.rpcCalls).toEqual([]);
  });

  it('calls activate_feed_algorithm_version with the resolved id under --apply and prints its JSON', async () => {
    const returned = { previous_active_id: V1, activated_id: V3, algorithm_key: 'for-you-rules', version: 3 };
    const result = await run(['activate', '--key', 'for-you-rules', '--version', '3', '--apply'], {
      rpcResults: { activate_feed_algorithm_version: { data: returned, error: null } },
    });
    expect(result.exitCode).toBe(0);
    expect(result.rpcCalls).toEqual([{ name: 'activate_feed_algorithm_version', args: { p_version_id: V3 } }]);
    expect(result.stdout).toContain(JSON.stringify(returned, null, 2));
    expect(result.stdout).not.toContain('Dry run');
  });

  it('accepts a draft target', async () => {
    const result = await run(['activate', '--key', 'for-you-rules', '--version', '4', '--apply']);
    expect(result.exitCode).toBe(0);
    expect(result.rpcCalls).toEqual([{ name: 'activate_feed_algorithm_version', args: { p_version_id: V4 } }]);
  });

  it('refuses an active target, even with --apply', async () => {
    const result = await run(['activate', '--key', 'for-you-rules', '--version', '1', '--apply']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('for-you-rules-v1 is already active.');
    expect(result.rpcCalls).toEqual([]);
  });

  it('activates a retired target again: that is the rollback', async () => {
    const result = await run(['activate', '--key', 'for-you-rules', '--version', '1', '--apply'], {
      versions: AFTER_V3_ACTIVATION,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`for-you-rules-v3\\s+active → retired\\s+${V3}`));
    expect(result.stdout).toMatch(new RegExp(`for-you-rules-v1\\s+retired → active\\s+${V1}`));
    expect(result.rpcCalls).toEqual([{ name: 'activate_feed_algorithm_version', args: { p_version_id: V1 } }]);
  });

  it('refuses a version that does not exist', async () => {
    const result = await run(['activate', '--key', 'for-you-rules', '--version', '9', '--apply']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No feed algorithm version for-you-rules-v9.');
    expect(result.rpcCalls).toEqual([]);
  });

  it('exits 1 with the RPC error when the database refuses', async () => {
    const result = await run(['activate', '--key', 'for-you-rules', '--version', '3', '--apply'], {
      rpcResults: {
        activate_feed_algorithm_version: { data: null, error: { message: 'target is not draft or shadow', code: 'P0001' } },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('activate_feed_algorithm_version failed: target is not draft or shadow (P0001)');
  });
});

describe('experiment start', () => {
  it('gives control 10000 minus the treatment share', () => {
    const payload = (treatmentBasisPoints: number) => buildCreateExperimentPayload({
      experimentKey: 'k',
      trafficBasisPoints: 10000,
      treatmentBasisPoints,
      controlVersionId: V1,
      treatmentVersionId: V3,
    }).p_variants.map((variant) => [variant.variant_key, variant.allocation_basis_points]);
    expect(payload(3000)).toEqual([['control', 7000], ['treatment', 3000]]);
    expect(payload(5000)).toEqual([['control', 5000], ['treatment', 5000]]);
    expect(payload(1)).toEqual([['control', 9999], ['treatment', 1]]);
    expect(payload(10000)).toEqual([['control', 0], ['treatment', 10000]]);
  });

  it.each([0, 10001, 2.5, -1, Number.NaN])('rejects %s basis points', (basisPoints) => {
    const input = {
      experimentKey: 'k', trafficBasisPoints: 10000, treatmentBasisPoints: 5000,
      controlVersionId: V1, treatmentVersionId: V3,
    };
    expect(() => buildCreateExperimentPayload({ ...input, treatmentBasisPoints: basisPoints })).toThrow(
      '--treatment-bps must be a whole number from 1 to 10000.',
    );
    expect(() => buildCreateExperimentPayload({ ...input, trafficBasisPoints: basisPoints })).toThrow(
      '--traffic-bps must be a whole number from 1 to 10000.',
    );
  });

  it('prints the plan and calls nothing without --apply', async () => {
    const result = await run([
      'experiment', 'start', '--key', 'v3-vs-v1', '--control', '1', '--treatment', '3', '--treatment-bps', '3000',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Start experiment v3-vs-v1');
    expect(result.stdout).toMatch(/traffic\s+10000 bps \(100\.00%\) of viewers enrolled/);
    expect(result.stdout).toMatch(/control\s+for-you-rules-v1 \(active\)\s+7000 bps \(70\.00%\) of enrolled viewers/);
    expect(result.stdout).toMatch(/treatment\s+for-you-rules-v3 \(shadow\)\s+3000 bps \(30\.00%\) of enrolled viewers/);
    expect(result.stdout).toContain('Dry run: nothing was changed. Re-run with --apply to call create_feed_experiment.');
    expect(result.rpcCalls).toEqual([]);
  });

  it('calls create_feed_experiment with the exact payload under --apply', async () => {
    const result = await run([
      'experiment', 'start', '--key', 'v3-vs-v1', '--control', '1', '--treatment', '3',
      '--treatment-bps', '3000', '--apply',
    ], {
      rpcResults: { create_feed_experiment: { data: { experiment_id: 'new-experiment' }, error: null } },
    });
    expect(result.exitCode).toBe(0);
    expect(result.rpcCalls).toEqual([{
      name: 'create_feed_experiment',
      args: {
        p_experiment: { experiment_key: 'v3-vs-v1', traffic_basis_points: 10000, status: 'running' },
        p_variants: [
          { variant_key: 'control', algorithm_version_id: V1, allocation_basis_points: 7000 },
          { variant_key: 'treatment', algorithm_version_id: V3, allocation_basis_points: 3000 },
        ],
      },
    }]);
    expect(result.stdout).toContain('"experiment_id": "new-experiment"');
  });

  it('passes partial traffic through and says who stays on the active version', async () => {
    const result = await run([
      'experiment', 'start', '--key', 'v3-quarter', '--control', '1', '--treatment', '3',
      '--traffic-bps', '2500', '--apply',
    ]);
    expect(result.stdout).toContain('Viewers outside the experiment keep for-you-rules-v1, the active version.');
    expect(result.rpcCalls).toHaveLength(1);
    expect(result.rpcCalls[0].args).toMatchObject({
      p_experiment: { traffic_basis_points: 2500 },
      p_variants: [{ allocation_basis_points: 5000 }, { allocation_basis_points: 5000 }],
    });
  });

  it('allows an A/A run with one version in both arms', async () => {
    const result = await run([
      'experiment', 'start', '--key', 'aa-v1', '--control', '1', '--treatment', '1', '--apply',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Control and treatment are the same version: an A/A run.');
    expect(result.rpcCalls[0].args).toMatchObject({
      p_variants: [{ algorithm_version_id: V1 }, { algorithm_version_id: V1 }],
    });
  });

  it('rejects basis points outside 1–10000 before reading anything', async () => {
    for (const flag of ['--traffic-bps', '--treatment-bps']) {
      for (const value of ['0', '10001']) {
        const result = await run([
          'experiment', 'start', '--key', 'k', '--control', '1', '--treatment', '3', flag, value, '--apply',
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`${flag} must be a whole number from 1 to 10000.`);
        expect(result.selects).toEqual([]);
        expect(result.rpcCalls).toEqual([]);
      }
    }
  });

  it('refuses a draft or missing version for either arm', async () => {
    const draft = await run([
      'experiment', 'start', '--key', 'k', '--control', '1', '--treatment', '4', '--apply',
    ]);
    expect(draft.exitCode).toBe(1);
    expect(draft.stderr).toContain(
      'for-you-rules-v4 (treatment) is draft; create_feed_experiment takes only an active or shadow version.',
    );

    const missing = await run([
      'experiment', 'start', '--key', 'k', '--control', '9', '--treatment', '3', '--apply',
    ]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('No feed algorithm version for-you-rules-v9 for the control.');
    expect([...draft.rpcCalls, ...missing.rpcCalls]).toEqual([]);
  });

  it('refuses a key that already exists and a second running experiment', async () => {
    const duplicate = await run([
      'experiment', 'start', '--key', 'v3-vs-v1', '--control', '1', '--treatment', '3', '--apply',
    ], { experiments: [experimentRow('v3-vs-v1', 'completed')] });
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain('Experiment v3-vs-v1 already exists (completed).');

    const second = await run([
      'experiment', 'start', '--key', 'v2-vs-v1', '--control', '1', '--treatment', '2', '--apply',
    ], { experiments: [experimentRow('v3-vs-v1', 'running')] });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('Experiment v3-vs-v1 is running');
    expect(second.stderr).toContain('experiment stop --key v3-vs-v1');
    expect([...duplicate.rpcCalls, ...second.rpcCalls]).toEqual([]);
  });
});

describe('experiment stop', () => {
  const running = { experiments: [experimentRow('v3-vs-v1', 'running')] };

  it('prints the status change and calls nothing without --apply', async () => {
    const result = await run(['experiment', 'stop', '--key', 'v3-vs-v1'], running);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Stop experiment v3-vs-v1');
    expect(result.stdout).toMatch(/status\s+running → completed/);
    expect(result.stdout).toMatch(/control\s+for-you-rules-v1\s+5000 bps \(50\.00%\)/);
    expect(result.stdout).toContain('Afterwards every viewer gets for-you-rules-v1, the active version.');
    expect(result.stdout).toContain(
      'Dry run: nothing was changed. Re-run with --apply to call set_feed_experiment_status.',
    );
    expect(result.rpcCalls).toEqual([]);
  });

  it('calls set_feed_experiment_status with the resolved id under --apply', async () => {
    const completed = await run(['experiment', 'stop', '--key', 'v3-vs-v1', '--apply'], running);
    expect(completed.exitCode).toBe(0);
    expect(completed.rpcCalls).toEqual([{
      name: 'set_feed_experiment_status',
      args: { p_experiment_id: 'experiment-v3-vs-v1', p_status: 'completed' },
    }]);
    expect(completed.stdout).toContain('Applied with set_feed_experiment_status:');

    const paused = await run(['experiment', 'stop', '--key', 'v3-vs-v1', '--status', 'paused', '--apply'], running);
    expect(paused.rpcCalls).toEqual([{
      name: 'set_feed_experiment_status',
      args: { p_experiment_id: 'experiment-v3-vs-v1', p_status: 'paused' },
    }]);
  });

  it('can finish a paused experiment', async () => {
    const result = await run(['experiment', 'stop', '--key', 'v3-vs-v1', '--status', 'cancelled', '--apply'], {
      experiments: [experimentRow('v3-vs-v1', 'paused')],
    });
    expect(result.exitCode).toBe(0);
    expect(result.rpcCalls[0].args).toEqual({ p_experiment_id: 'experiment-v3-vs-v1', p_status: 'cancelled' });
  });

  it('refuses an unknown key, a finished experiment and a no-op', async () => {
    const unknown = await run(['experiment', 'stop', '--key', 'nope', '--apply'], running);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('No feed experiment nope.');

    const finished = await run(['experiment', 'stop', '--key', 'v3-vs-v1', '--apply'], {
      experiments: [experimentRow('v3-vs-v1', 'completed')],
    });
    expect(finished.exitCode).toBe(1);
    expect(finished.stderr).toContain('Experiment v3-vs-v1 is already completed.');

    const noop = await run(['experiment', 'stop', '--key', 'v3-vs-v1', '--status', 'paused', '--apply'], {
      experiments: [experimentRow('v3-vs-v1', 'paused')],
    });
    expect(noop.exitCode).toBe(1);
    expect(noop.stderr).toContain('Experiment v3-vs-v1 is already paused.');

    expect([...unknown.rpcCalls, ...finished.rpcCalls, ...noop.rpcCalls]).toEqual([]);
  });
});
