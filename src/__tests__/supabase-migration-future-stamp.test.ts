import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CLOCK_SKEW_ALLOWANCE_MS,
  describeFutureDatedMigrations,
  findFutureDatedMigrations,
  migrationVersionAt,
  migrationVersionTime,
  parseMigrationFileNames,
} from '../../.github/scripts/apply-supabase-migrations.mjs';

// A migration's version is the only thing that orders it, and the release
// refuses a pending migration that sorts at or below the newest applied one.
// So a file stamped later than the real UTC time outranks every migration
// written with an honest `date -u` stamp: the next release that carries one of
// those fails, and so does every release after it. That happened on 2026-09-29
// and again on 2026-10-02. These tests make the change that adds such a file
// fail instead, and pin the release refusing to apply one.

// The release script is plain ESM with no declarations, so the shapes it hands
// back are named here rather than inferred as `any`.
type MigrationFile = { fileName: string; version: string; name: string };
type FutureDated = MigrationFile & { aheadMs: number };

const futureDated = (
  migrations: MigrationFile[],
  now: Date,
  allowanceMs?: number,
): FutureDated[] => findFutureDatedMigrations(migrations, { now, allowanceMs }) as FutureDated[];

const file = (fileName: string): MigrationFile => parseMigrationFileNames([fileName])[0];
const at = (iso: string): Date => new Date(iso);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// The two files that did it, and the moment each one reached main.
const nsfwLabels = file('20260929120000_manual_nsfw_content.sql');
const nsfwLabelsMerged = at('2026-09-29T03:52:40Z');
const checkpointRetry = file('20261003010000_atomic_template_checkpoint_retry.sql');
const checkpointRetryMerged = at('2026-10-02T20:09:35Z');

const repositoryRoot = process.cwd();
const repositoryMigrations: MigrationFile[] = parseMigrationFileNames(
  fs.readdirSync(path.join(repositoryRoot, 'supabase/migrations')),
);

describe('future-dated migration versions', () => {
  const machineZone = process.env.TZ;

  afterEach(() => {
    if (machineZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = machineZone;
    }
  });

  it('reads a version as the UTC second it names', () => {
    expect(migrationVersionTime('20261003010000')).toBe(Date.parse('2026-10-03T01:00:00Z'));
    expect(migrationVersionAt(at('2026-10-02T20:09:35.900Z'))).toBe('20261002200935');
  });

  // CI runs in UTC, where reading a version as local time would go unnoticed.
  // The first assertion is the control: it fails if the zone did not change.
  it.each([
    { zone: 'Asia/Kolkata', minutesBehindUtc: -330 },
    { zone: 'America/Los_Angeles', minutesBehindUtc: 420 },
    { zone: 'UTC', minutesBehindUtc: 0 },
  ])('reads it the same way on a machine in $zone', ({ zone, minutesBehindUtc }) => {
    process.env.TZ = zone;
    expect(checkpointRetryMerged.getTimezoneOffset()).toBe(minutesBehindUtc);

    expect(migrationVersionTime('20261003010000')).toBe(Date.parse('2026-10-03T01:00:00Z'));
    expect(migrationVersionAt(checkpointRetryMerged)).toBe('20261002200935');
    expect(futureDated([checkpointRetry], checkpointRetryMerged)).toEqual([
      { ...checkpointRetry, aheadMs: 4 * HOUR + 50 * MINUTE + 25 * SECOND },
    ]);
  });

  it('flags the two migrations that broke a release, and by how much', () => {
    expect(futureDated([nsfwLabels], nsfwLabelsMerged)).toEqual([
      { ...nsfwLabels, aheadMs: 8 * HOUR + 7 * MINUTE + 20 * SECOND },
    ]);
    expect(futureDated([checkpointRetry], checkpointRetryMerged)).toEqual([
      { ...checkpointRetry, aheadMs: 4 * HOUR + 50 * MINUTE + 25 * SECOND },
    ]);
  });

  it('passes the same files once their time has come', () => {
    expect(futureDated([nsfwLabels], at('2026-09-29T12:00:00Z'))).toEqual([]);
    expect(futureDated([nsfwLabels, checkpointRetry], at('2026-10-03T13:00:00Z'))).toEqual([]);
  });

  it('passes a migration stamped with the real time', () => {
    // #290's migration as first written, read when it merged.
    const lastEventTime = file('20261002184734_mobile_notification_last_event_time.sql');
    expect(futureDated([lastEventTime], at('2026-10-02T20:36:27Z'))).toEqual([]);

    const now = at('2026-10-03T13:49:32.418Z');
    expect(futureDated([file(`${migrationVersionAt(now)}_written_just_now.sql`)], now)).toEqual([]);
  });

  it('catches local time written as if it were UTC', () => {
    // 01:00 on 3 October in India is 19:30 UTC the evening before.
    expect(futureDated([checkpointRetry], at('2026-10-02T19:30:00Z'))).toEqual([
      { ...checkpointRetry, aheadMs: 5 * HOUR + 30 * MINUTE },
    ]);
  });

  it('allows for clock skew and nothing more', () => {
    const stamped = Date.parse('2026-10-03T01:00:00Z');

    expect(futureDated([checkpointRetry], new Date(stamped - CLOCK_SKEW_ALLOWANCE_MS))).toEqual([]);
    expect(
      futureDated([checkpointRetry], new Date(stamped - CLOCK_SKEW_ALLOWANCE_MS - SECOND)),
    ).toEqual([{ ...checkpointRetry, aheadMs: CLOCK_SKEW_ALLOWANCE_MS + SECOND }]);

    expect(futureDated([checkpointRetry], new Date(stamped), 0)).toEqual([]);
    expect(futureDated([checkpointRetry], new Date(stamped - SECOND), 0)).toEqual([
      { ...checkpointRetry, aheadMs: SECOND },
    ]);
  });

  it('reads the versions already on main that are not clock times', () => {
    // Four applied migrations are numbered ...106000 to ...109000, minute 60 to
    // 90. They cannot be renamed, so they have to read as a time, not as NaN:
    // a comparison against NaN is false and would pass anything.
    expect(migrationVersionTime('20260810106000')).toBe(Date.parse('2026-08-10T11:00:00Z'));
    expect(migrationVersionTime('20260810109000')).toBe(Date.parse('2026-08-10T11:30:00Z'));

    expect(repositoryMigrations.length).toBeGreaterThan(150);
    for (const { version } of repositoryMigrations) {
      expect(Number.isFinite(migrationVersionTime(version))).toBe(true);
    }
  });

  it('refuses to read anything that is not a fourteen-digit version', () => {
    expect(() => migrationVersionTime('20261003')).toThrow('not YYYYMMDDHHMMSS');
    expect(() => migrationVersionTime('2026-10-03T01:00')).toThrow('not YYYYMMDDHHMMSS');
  });

  it('names each file, how far ahead it is and how to restamp it', () => {
    const message = describeFutureDatedMigrations(
      futureDated([nsfwLabels, checkpointRetry], nsfwLabelsMerged),
      nsfwLabelsMerged,
    );

    expect(message).toContain('20260929120000_manual_nsfw_content.sql (8h 7m ahead)');
    expect(message).toContain('20261003010000_atomic_template_checkpoint_retry.sql (3d 21h ahead)');
    expect(message).toContain('The UTC clock reads 20260929035240.');
    expect(message).toContain('date -u +%Y%m%d%H%M%S');
  });
});

// The release script run for real, with a stand-in for the Management API
// loaded into the same process: GET answers with the ledger file, and POST
// files the migration under the time it was applied, as the real API does.
const fakeManagementApi = `
import fs from 'node:fs';

const ledgerFile = process.env.FAKE_LEDGER_FILE;

globalThis.fetch = async (_url, { method, body } = {}) => {
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  if (method !== 'POST') {
    return Response.json(ledger);
  }

  const version = new Date().toISOString().replace(/\\D/g, '').slice(0, 14);
  ledger.push({ version, name: JSON.parse(body).name });
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  return Response.json({});
};
`;

const releaseScript = fs.realpathSync(
  path.join(repositoryRoot, '.github/scripts/apply-supabase-migrations.mjs'),
);

function release({ files, applied }: { files: string[]; applied: string[] }) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-release-'));

  try {
    const migrationsDirectory = path.join(project, 'supabase/migrations');
    fs.mkdirSync(migrationsDirectory, { recursive: true });
    for (const fileName of files) {
      fs.writeFileSync(path.join(migrationsDirectory, fileName), 'select 1;\n');
    }

    const ledgerFile = path.join(project, 'ledger.json');
    const ledger: MigrationFile[] = parseMigrationFileNames(applied);
    fs.writeFileSync(
      ledgerFile,
      JSON.stringify(ledger.map(({ version, name }) => ({ version, name }))),
    );

    const api = path.join(project, 'fake-management-api.mjs');
    fs.writeFileSync(api, fakeManagementApi);

    const run = spawnSync(process.execPath, ['--import', pathToFileURL(api).href, releaseScript], {
      cwd: project,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        SUPABASE_ACCESS_TOKEN: 'not-a-real-token',
        SUPABASE_PROJECT_REF: 'notarealprojectref',
        FAKE_LEDGER_FILE: ledgerFile,
      },
    });

    const recorded: { name: string }[] = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    return {
      status: run.status,
      output: `${run.stdout}${run.stderr}`,
      appliedNames: recorded.map(({ name }) => name),
    };
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}

describe('the release and a future-dated migration', { timeout: 90_000 }, () => {
  // The release reads the real clock, so its fixtures are stamped relative to it.
  const stampedFromNow = (offsetMs: number, name: string): string =>
    `${migrationVersionAt(new Date(Date.now() + offsetMs))}_${name}.sql`;

  const base = '20260101000000_base.sql';

  it('applies a migration stamped with the real time', () => {
    const honest = stampedFromNow(-MINUTE, 'honest');

    const { status, output, appliedNames } = release({ files: [base, honest], applied: [base] });

    expect(output).toContain(`Applied ${honest}.`);
    expect(output).toContain('Supabase migration history verified.');
    expect(status).toBe(0);
    expect(appliedNames).toEqual(['base', 'honest']);
  });

  it('refuses a future-dated migration before applying anything', () => {
    const honest = stampedFromNow(-MINUTE, 'honest');
    const ahead = stampedFromNow(6 * HOUR, 'ahead');

    const { status, output, appliedNames } = release({
      files: [base, honest, ahead],
      applied: [base],
    });

    expect(output).toContain(`Refusing to apply future-dated migration ${ahead} (`);
    expect(output).toMatch(/\((5h 59m|6h 0m) ahead\)/);
    expect(status).toBe(1);
    expect(appliedNames).toEqual(['base']);
  });

  it('does not hold a release over a future-dated migration production already has', () => {
    const ahead = stampedFromNow(6 * HOUR, 'ahead');

    const { status, output, appliedNames } = release({
      files: [base, ahead],
      applied: [base, ahead],
    });

    expect(output).toContain('Supabase migration history is already current.');
    expect(status).toBe(0);
    expect(appliedNames).toEqual(['base', 'ahead']);
  });

  it('shows what the refusal prevents: once one is applied, the real time is out of order', () => {
    // Both incidents, as the next release met them.
    const honest = stampedFromNow(-MINUTE, 'honest');
    const ahead = stampedFromNow(6 * HOUR, 'ahead');

    const { status, output, appliedNames } = release({
      files: [base, honest, ahead],
      applied: [base, ahead],
    });

    expect(output).toContain(`Refusing to apply out-of-order migration ${honest}.`);
    expect(status).toBe(1);
    expect(appliedNames).toEqual(['base', 'ahead']);
  });
});

// The check has to know which files a change adds. A future-dated file that has
// already reached main is in every checkout made after it, so failing on it
// would turn main and every unrelated branch red until its time passed, and a
// red main stops every release. Only what main does not have yet is checked.
const mainRef = 'origin/main';

/** The migration file names main has, or null when this checkout cannot say. */
function readMainMigrationFileNames(): string[] | null {
  try {
    return execFileSync(
      'git',
      ['ls-tree', '--name-only', mainRef, 'supabase/migrations/'],
      { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .split('\n')
      .filter(Boolean)
      .map((filePath) => path.basename(filePath));
  } catch {
    return null;
  }
}

/** What a checkout would add to main. With no list from main, every file counts. */
function notOnMain(migrations: MigrationFile[], mainFileNames: string[] | null): MigrationFile[] {
  if (!mainFileNames) {
    return migrations;
  }

  const onMain = new Set(mainFileNames);
  return migrations.filter(({ fileName }) => !onMain.has(fileName));
}

describe('migrations this checkout adds to main', () => {
  const mainFileNames = readMainMigrationFileNames();

  it('adds none stamped ahead of the clock', () => {
    const now = new Date();
    const ahead = futureDated(notOnMain(repositoryMigrations, mainFileNames), now);

    expect(
      ahead.map(({ fileName }) => fileName),
      `Future-dated migration ${describeFutureDatedMigrations(ahead, now)}`,
    ).toEqual([]);
  });

  it('leaves out a file main already has, however far ahead it is stamped', () => {
    const added = file('20261003184500_added_here.sql');

    expect(notOnMain([checkpointRetry, added], [checkpointRetry.fileName])).toEqual([added]);
    expect(
      futureDated(notOnMain([checkpointRetry], [checkpointRetry.fileName]), checkpointRetryMerged),
    ).toEqual([]);
  });

  it('counts a file main has under another stamp as added', () => {
    const restamped = file('20261003010001_atomic_template_checkpoint_retry.sql');

    expect(notOnMain([restamped], [checkpointRetry.fileName])).toEqual([restamped]);
  });

  it('checks every file when main cannot be read', () => {
    expect(notOnMain([nsfwLabels, checkpointRetry], null)).toEqual([nsfwLabels, checkpointRetry]);
  });

  it.skipIf(mainFileNames === null)('reads the migration list main has', () => {
    expect(mainFileNames?.length).toBeGreaterThan(150);
    expect(mainFileNames).toContain(repositoryMigrations[0].fileName);
  });

  it('gives the CI test job main to compare against', () => {
    // A pull request's checkout holds only its own merge commit. Without this
    // fetch the check falls back to every file, and a future-dated file that
    // reached main would fail every pull request until its time passed.
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/quality.yml'),
      'utf8',
    );
    const webJob = workflow.slice(workflow.indexOf('\n  web:'), workflow.indexOf('\n  e2e:'));
    const fetchMain = webJob.indexOf(
      `git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/${mainRef}`,
    );

    expect(fetchMain).toBeGreaterThan(-1);
    expect(webJob.indexOf('run: npm test')).toBeGreaterThan(fetchMain);
  });
});
