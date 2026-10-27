// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// Quality's "Supabase API integration" job died at `supabase start` on 2026-10-14, 10-19 (main, so no release),
// 10-22 and 10-27 with nothing printed: the step sent the CLI's output to a file, which the stop step deletes, and a
// failed start has already removed its containers. These run the step's bash, read from quality.yml, as Actions
// does (`bash -e`), with supabase, docker, sudo and ss stood in for, through each outcome.

const STEP = 'Start isolated Supabase API stack';

/** The step's `run: |` block, dedented as Actions hands it to bash. */
function stepScript() {
  const workflow = readFileSync(path.join(process.cwd(), '.github/workflows/quality.yml'), 'utf8');
  const at = workflow.indexOf(`\n      - name: ${STEP}\n`);
  expect(at).toBeGreaterThan(-1);
  const step = workflow.slice(at + 1).split(/\n(?= {0,6}\S)/)[0];
  const body = step.split('        run: |\n')[1];
  expect(body).toBeDefined();
  return body.split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
}

// Key-shaped values, put together here so that this file holds none whole.
const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0', 'c3RhbmQtaW4'].join('.');
const secretKey = ['sb', 'secret', 'c3RhbmQtaW4ta2V5'].join('_');
const jwtSecret = 'stand-in-jwt-secret-of-at-least-32-characters';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Outcome = { output: string; code: number };

// supabase answers `start` and `db reset` as told; docker lists the containers it is given and prints log lines
// holding a JWT and an env-style secret; sudo runs what follows -n; ss lists the stack's db port and one other.
const STUBS: Record<string, string> = {
  supabase: `echo "$*" >> "$STUB_DIR/supabase-calls"
case "$3" in
  start) printf '%s' "$START_OUTPUT"; exit "$START_CODE" ;;
  db) printf '%s' "$RESET_OUTPUT"; exit "$RESET_CODE" ;;
  status) echo '{}' ;;
esac`,
  docker: `echo "$*" >> "$STUB_DIR/docker-calls"
case "$*" in
  *label=com.supabase.cli.project*) printf '%s' "$PROJECT_CONTAINERS" ;;
  ps*) printf 'NAMES IMAGE STATUS PORTS\\n(stand-in table)\\n' ;;
  logs*) echo "$4: GOTRUE_JWT_SECRET=$JWT_SECRET and $JWT" ;;
esac`,
  sudo: `[ "$1" = -n ] && shift
exec "$@"`,
  ss: `echo 'LISTEN 0 4096 0.0.0.0:54322 0.0.0.0:* users:(("docker-proxy",pid=4242,fd=7))'
echo 'LISTEN 0 4096 127.0.0.53:53 0.0.0.0:* users:(("systemd-resolve",pid=600,fd=14))'`,
};

function run(start: Outcome, reset: Outcome = { output: '', code: 0 }, containers = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'supabase-api-start-'));
  made.push(dir);
  const workspace = path.join(dir, 'workspace');
  const runnerTemp = path.join(dir, 'runner-temp');
  const bin = path.join(dir, 'bin');
  for (const folder of [path.join(workspace, 'supabase/migrations'), runnerTemp, bin]) {
    mkdirSync(folder, { recursive: true });
  }
  writeFileSync(path.join(workspace, 'supabase/config.api-tests.toml'), 'project_id = "magicbooklet-api-tests"\n');
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  const githubEnv = path.join(dir, 'github-env');
  const result = spawnSync('bash', ['-e', '-c', stepScript()], {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_WORKSPACE: workspace,
      GITHUB_ENV: githubEnv,
      STUB_DIR: dir,
      START_OUTPUT: start.output,
      START_CODE: String(start.code),
      RESET_OUTPUT: reset.output,
      RESET_CODE: String(reset.code),
      PROJECT_CONTAINERS: containers,
      JWT: jwt,
      JWT_SECRET: jwtSecret,
    },
    encoding: 'utf8',
  });
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  return {
    status: result.status,
    stdout: result.stdout,
    all: `${result.stdout}${result.stderr}`,
    supabaseCalls: read(path.join(dir, 'supabase-calls')) ?? '',
    dockerCalls: read(path.join(dir, 'docker-calls')),
    githubEnv: read(githubEnv),
    runnerTemp,
  };
}

/** What CLI 2.109.1 writes when a service misses its 30 s health check: that container's logs, then the error. */
const UNHEALTHY_START = [
  'Starting database...',
  'Initialising schema...',
  'Applying migration 20260223171338_remote_schema.sql...',
  'Starting containers...',
  'Waiting for health checks...',
  'supabase_auth_magicbooklet-api-tests container logs:',
  `{"level":"fatal","msg":"config: GOTRUE_JWT_SECRET=${jwtSecret} anon ${jwt} ${secretKey}"}`,
  'Stopping containers...',
  'supabase_auth_magicbooklet-api-tests container is not ready: unhealthy',
  'Try rerunning the command with --debug to troubleshoot the error.',
  '',
].join('\n');

describe("the Supabase API job's start step", () => {
  it('prints the start log, keys masked, with its error as an annotation, when supabase start fails', () => {
    const result = run({ output: UNHEALTHY_START, code: 1 });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Applying migration 20260223171338_remote_schema.sql...');
    expect(result.stdout).toContain('supabase_auth_magicbooklet-api-tests container logs:');
    expect(result.stdout).toContain(
      '::error title=supabase start exited 1::supabase_auth_magicbooklet-api-tests container is not ready: unhealthy\n',
    );
    expect(result.stdout).toContain('GOTRUE_JWT_SECRET=[redacted] anon [jwt redacted] sb_secret_[redacted]');
    for (const secret of [jwt, secretKey, jwtSecret]) expect(result.all).not.toContain(secret);
    expect(result.supabaseCalls).not.toContain('db reset');
  });

  it('says what holds the stack\'s ports and which containers are left after a failed start', () => {
    const result = run({ output: UNHEALTHY_START, code: 1 });

    expect(result.stdout).toContain('0.0.0.0:54322 0.0.0.0:* users:(("docker-proxy",pid=4242,fd=7))');
    expect(result.stdout).not.toContain('systemd-resolve');
    expect(result.stdout).toContain('::group::Containers on the runner\nNAMES IMAGE STATUS PORTS\n(stand-in table)\n');
  });

  it('keeps the exit code of a start killed before it wrote an error, and says so', () => {
    const result = run({ output: 'Starting database...\n', code: 137 });

    expect(result.status).toBe(137);
    expect(result.stdout).toContain('Starting database...\n');
    expect(result.stdout).toContain('::error title=supabase start exited 137::Starting database...\n');
    expect(run({ output: '', code: 137 }).stdout).toContain('::error title=supabase start exited 137::no output\n');
  });

  it('escapes a percent sign in the annotation, as workflow commands require', () => {
    const result = run({ output: 'failed to pull docker image: Get "https://example.test/v2/?scope=a%2Fb": EOF\n', code: 1 });

    expect(result.stdout).toContain('::error title=supabase start exited 1::failed to pull docker image: Get "https://example.test/v2/?scope=a%252Fb": EOF\n');
  });

  it('keeps the start log, which then ends in the key table, unprinted when db reset fails, and shows the containers that are not up and healthy', () => {
    const containers = [
      'supabase_db_magicbooklet-api-tests Up 2 minutes (healthy)',
      'supabase_kong_magicbooklet-api-tests Up 2 minutes',
      'supabase_auth_magicbooklet-api-tests Up 1 second (health: starting)',
      'supabase_rest_magicbooklet-api-tests Up 2 minutes (unhealthy)',
      'supabase_storage_magicbooklet-api-tests Exited (1) 3 seconds ago',
      '',
    ].join('\n');
    const result = run(
      { output: `Started supabase local development setup.\n│ Secret │ ${secretKey} │\n`, code: 0 },
      { output: 'Applying migration 20261027000000_stand_in.sql...\nERROR: stand-in failure (SQLSTATE 42601)\n', code: 2 },
      containers,
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('ERROR: stand-in failure (SQLSTATE 42601)');
    expect(result.all).not.toContain('Started supabase local development setup.');
    expect(result.stdout).toContain('Last 50 log lines of supabase_auth_magicbooklet-api-tests (Up 1 second (health: starting))');
    expect(result.stdout).toContain('Last 50 log lines of supabase_rest_magicbooklet-api-tests (Up 2 minutes (unhealthy))');
    expect(result.stdout).toContain('Last 50 log lines of supabase_storage_magicbooklet-api-tests (Exited (1) 3 seconds ago)');
    expect(result.stdout).toContain('supabase_storage_magicbooklet-api-tests: GOTRUE_JWT_SECRET=[redacted] and [jwt redacted]');
    expect(result.stdout).not.toContain('Last 50 log lines of supabase_db');
    expect(result.stdout).not.toContain('Last 50 log lines of supabase_kong');
    expect(result.stdout).not.toContain('docker-proxy');
    for (const secret of [jwt, secretKey, jwtSecret]) expect(result.all).not.toContain(secret);
  });

  it('prints nothing of the start log, and hands the tests the status file, when the stack starts', () => {
    const result = run({ output: `Started supabase local development setup.\n│ Secret │ ${secretKey} │\n`, code: 0 });

    expect(result.status).toBe(0);
    expect(result.all).not.toContain('Started supabase local development setup.');
    expect(result.all).not.toContain(secretKey);
    expect(result.dockerCalls).toBeNull();
    expect(result.githubEnv).toBe(`AUDIT_STORAGE_CONFIG=${result.runnerTemp}/supabase-api-status.json\n`);
    expect(readFileSync(path.join(result.runnerTemp, 'supabase-api-status.json'), 'utf8')).toBe('{}\n');
  });
});
