// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// Quality's "Supabase API integration" job died at `supabase start` on 2026-10-14, 10-19 (main, so no release),
// 10-22 and 10-27 with nothing printed: the step sent the CLI's output to a file, which the stop step deletes, and a
// failed start has already removed its containers. These run the step's bash, read from quality.yml, as Actions
// does (`bash -e`), with supabase, docker, timeout, sudo and ss stood in for, through each outcome. The stand-ins
// write where the real tools do: the CLI's progress, container logs and errors go to stderr, so a step that stops
// capturing stderr fails here too.

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
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

type Outcome = { output: string; code: number };

// supabase answers `start` and `db reset` as told, and before a start returns waits for the job log follower to
// finish, so no case races it; docker streams the start events, one-off and tail logs and container lists it is
// given; timeout records its limit and runs the rest; sudo runs what follows -n; ss lists sockets on and off the
// stack's ports.
const STUBS: Record<string, string> = {
  supabase: `echo "$*" >> "$STUB_DIR/supabase-calls"
case "$3" in
  start)
    printf '%s' "$START_OUTPUT" >&2
    if [ "$START_CODE" = 0 ]; then printf 'Started supabase local development setup.\\n| Secret | %s |\\n' "$SECRET_KEY"; fi
    if [ -n "$EVENTS" ]; then
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
        grep -qs 'end of job log' "$RUNNER_TEMP"/supabase-api-jobs/*.log && break
        sleep 0.25
      done
    fi
    exit "$START_CODE" ;;
  db) printf '%s' "$RESET_OUTPUT" >&2; exit "$RESET_CODE" ;;
  status) echo '{}' ;;
esac`,
  docker: `echo "$*" >> "$STUB_DIR/docker-calls"
case "$1 $2" in
  'events --filter') printf '%s' "$EVENTS" ;;
  'logs -f') printf '%s\\nend of job log\\n' "$JOB_LOG" ;;
  'logs --tail') echo "$4: GOTRUE_JWT_SECRET=$JWT_SECRET and $JWT" >&2 ;;
  'ps -a')
    case "$*" in
      *label=com.supabase.cli.project*) printf '%s' "$PROJECT_CONTAINERS" ;;
      *) printf 'NAMES IMAGE STATUS PORTS\\n(stand-in table)\\n' ;;
    esac ;;
esac`,
  timeout: `echo "$*" >> "$STUB_DIR/timeout-calls"
shift
exec "$@"`,
  sudo: `[ "$1" = -n ] && shift
exec "$@"`,
  ss: `echo "$*" >> "$STUB_DIR/ss-calls"
echo 'State     Recv-Q Send-Q Local Address:Port Peer Address:Port Process'
echo 'LISTEN    0      4096   127.0.0.53%lo:53   0.0.0.0:*         users:(("systemd-resolve",pid=600,fd=14))'
echo 'ESTAB     0      0      10.1.0.4:54322     3.5.6.7:443       users:(("dockerd",pid=812,fd=33))'
echo 'TIME-WAIT 0      0      10.1.0.4:54321     3.5.6.8:443'
echo 'LISTEN    0      244    127.0.0.1:5432     0.0.0.0:*         users:(("postgres",pid=900,fd=5))'`,
};

type Options = { reset?: Outcome; containers?: string; events?: string; jobLog?: string };

function run(start: Outcome, { reset = { output: '', code: 0 }, containers = '', events = '', jobLog = '' }: Options = {}) {
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
      EVENTS: events,
      JOB_LOG: jobLog,
      JWT: jwt,
      JWT_SECRET: jwtSecret,
      SECRET_KEY: secretKey,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  return {
    status: result.status,
    stdout: result.stdout,
    all: `${result.stdout}${result.stderr}`,
    calls: (tool: string) => read(path.join(dir, `${tool}-calls`)) ?? '',
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

/** A migration that fails during start: the error, the statement and a caret under the failing token. */
const MIGRATION_START = [
  'Starting database...',
  'Initialising schema...',
  'Applying migration 20261027000000_stand_in.sql...',
  'Stopping containers...',
  'ERROR: syntax error at or near "tabel" (SQLSTATE 42601)',
  'At statement: 0',
  'create tabel public.stand_in (',
  '       ^',
  'Try rerunning the command with --debug to troubleshoot the error.',
  '',
].join('\n');

/** Port 54322 taken while Docker binds it: the error, a blank line, then two suggestions. */
const PORT_START = [
  'Starting database...',
  'Stopping containers...',
  'failed to start docker container "supabase_db_magicbooklet-api-tests": Error response from daemon: driver failed '
    + 'programming external connectivity: listen tcp4 0.0.0.0:54322: bind: address already in use',
  '',
  'Try stopping the running container with docker stop supabase_db_other',
  'Or configure a different db port in supabase/config.toml',
  '',
].join('\n');

const annotation = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');

describe("the Supabase API job's start step", () => {
  it('prints the start log, keys masked, and names the error when a service misses its health check', () => {
    const result = run({ output: UNHEALTHY_START, code: 1 });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Applying migration 20260223171338_remote_schema.sql...');
    expect(result.stdout).toContain('supabase_auth_magicbooklet-api-tests container logs:');
    expect(result.stdout).toMatch(annotation(
      '::error title=supabase start exited 1::supabase_auth_magicbooklet-api-tests container is not ready: unhealthy',
    ));
    expect(result.stdout).toContain('GOTRUE_JWT_SECRET=[redacted] anon [jwt redacted] sb_secret_[redacted]');
    for (const secret of [jwt, secretKey, jwtSecret]) expect(result.all).not.toContain(secret);
    expect(result.calls('supabase')).not.toContain('db reset');
  });

  it('names a failed migration by its error, not by the caret under the statement', () => {
    const result = run({ output: MIGRATION_START, code: 1 });

    expect(result.stdout).toContain('create tabel public.stand_in (');
    expect(result.stdout).toMatch(annotation(
      '::error title=supabase start exited 1::ERROR: syntax error at or near "tabel" (SQLSTATE 42601)',
    ));
  });

  it('names a taken port by the bind error, and lists every socket on the stack\'s ports in any state', () => {
    const result = run({ output: PORT_START, code: 1 });

    expect(result.stdout).toMatch(/^::error title=supabase start exited 1::failed to start docker container .*0\.0\.0\.0:54322: bind: address already in use$/m);
    expect(result.calls('ss')).toBe('-tanp\n');
    expect(result.stdout).toContain('ESTAB     0      0      10.1.0.4:54322     3.5.6.7:443       users:(("dockerd",pid=812,fd=33))');
    expect(result.stdout).toContain('TIME-WAIT 0      0      10.1.0.4:54321     3.5.6.8:443');
    expect(result.stdout).not.toContain('systemd-resolve');
    expect(result.stdout).not.toContain('"postgres",pid=900');
    expect(result.stdout).toContain('::group::Containers on the runner\nNAMES IMAGE STATUS PORTS\n(stand-in table)\n');
  });

  it('starts the annotation on a line of its own when the log ends mid-line, and keeps a killed start\'s exit code', () => {
    const result = run({ output: 'Starting database...\npartial line with no newline', code: 137 });

    expect(result.status).toBe(137);
    expect(result.stdout).toMatch(/^partial line with no newline$/m);
    expect(result.stdout).toMatch(annotation('::error title=supabase start exited 137::partial line with no newline'));
    expect(run({ output: '', code: 137 }).stdout).toMatch(annotation('::error title=supabase start exited 137::no output'));
  });

  it('gives every command that can hang a time limit, and says when the start ran out of it', () => {
    // An init job's start event makes the stand-in start wait for the events pipeline, so its call is recorded.
    const result = run({ output: 'Pulling images...\n', code: 124 }, { events: 'c0ffee eager_turing storage-api\n' });

    expect(result.status).toBe(124);
    expect(result.stdout).toMatch(annotation('::error title=supabase start timed out after 8 minutes::Pulling images...'));
    const limits = result.calls('timeout').split('\n').filter(Boolean).map((call) => call.split(' ').slice(0, 3).join(' '));
    expect(limits).toEqual(expect.arrayContaining([
      '10m docker events',
      '8m supabase --workdir',
      '30 sudo -n',
      '30 docker ps',
    ]));
  });

  it('prints the logs of the CLI\'s one-off init containers, which it removes as they exit', () => {
    const result = run(
      { output: `Stopping containers...\nerror running container: exit 1\n`, code: 1 },
      {
        events: [
          'c0ffee eager_turing public.ecr.aws/supabase/storage-api:v1.0',
          'dbdbdb supabase_db_magicbooklet-api-tests public.ecr.aws/supabase/postgres:17',
          '',
        ].join('\n'),
        jobLog: `Error: connect ECONNREFUSED 172.17.0.2:5432 SERVICE_KEY=${jwt}`,
      },
    );

    expect(result.stdout).toMatch(annotation('::error title=supabase start exited 1::error running container: exit 1'));
    expect(result.stdout).toContain(
      '::group::One-off container eager_turing: public.ecr.aws/supabase/storage-api:v1.0\n'
        + 'Error: connect ECONNREFUSED 172.17.0.2:5432 SERVICE_KEY=[jwt redacted]\nend of job log\n::endgroup::\n',
    );
    expect(result.calls('docker')).toContain('logs -f c0ffee');
    expect(result.calls('docker')).not.toContain('logs -f dbdbdb');
    expect(result.all).not.toContain(jwt);
  });

  it('masks key-shaped values in the shapes the services print them, and leaves ordinary errors alone', () => {
    const lines = [
      'GOTRUE_JWT_SECRET="stand-in-1"',
      '{"jwt_secret":"stand-in-2","level":"info"}',
      'JWT_SECRET: stand-in-3',
      'api_key=stand-in-4',
      'PGRST_JWT_SECRET={"keys":[{"kty":"oct","k":"stand-in-5"}]}',
      "ALTER ROLE authenticator WITH PASSWORD 'stand-in-6';",
      `ANON_KEY=${jwt}`,
      'ERROR: duplicate key value violates unique constraint "posts_pkey"',
      'DETAIL:  Key (id)=(42) already exists.',
      'Stopping containers...',
      'stand-in failure',
      '',
    ];
    const result = run({ output: lines.join('\n'), code: 1 });

    for (const n of [1, 2, 3, 4, 5, 6]) expect(result.all).not.toContain(`stand-in-${n}`);
    for (const masked of [
      'GOTRUE_JWT_SECRET="[redacted]"',
      '{"jwt_secret":"[redacted]","level":"info"}',
      'JWT_SECRET: [redacted]',
      'api_key=[redacted]',
      'PGRST_JWT_SECRET={"keys":[{"kty":"oct","k":"[redacted]"}]}',
      "ALTER ROLE authenticator WITH PASSWORD '[redacted]';",
      'ANON_KEY=[jwt redacted]',
      'ERROR: duplicate key value violates unique constraint "posts_pkey"',
      'DETAIL:  Key (id)=(42) already exists.',
    ]) expect(result.stdout).toMatch(annotation(masked));
  });

  it('escapes a percent sign in the annotation, as workflow commands require', () => {
    const result = run({ output: 'failed to pull docker image: Get "https://example.test/v2/?scope=a%2Fb": EOF\n', code: 1 });

    expect(result.stdout).toMatch(annotation(
      '::error title=supabase start exited 1::failed to pull docker image: Get "https://example.test/v2/?scope=a%252Fb": EOF',
    ));
  });

  it('when db reset fails, masks its output, keeps the start log and its key table unprinted, and shows ports and the containers not up and healthy', () => {
    const containers = [
      'supabase_db_magicbooklet-api-tests Up 2 minutes (healthy)',
      'supabase_kong_magicbooklet-api-tests Up 2 minutes',
      'supabase_auth_magicbooklet-api-tests Up 1 second (health: starting)',
      'supabase_rest_magicbooklet-api-tests Up 2 minutes (unhealthy)',
      'supabase_storage_magicbooklet-api-tests Exited (1) 3 seconds ago',
      '',
    ].join('\n');
    const result = run({ output: 'Started supabase local development setup.\n', code: 0 }, {
      reset: {
        output: `Restarting containers...\nsupabase_storage_magicbooklet-api-tests container logs:\nPGRST_JWT_SECRET=${jwtSecret}\n`
          + 'supabase_storage_magicbooklet-api-tests container is not ready: unhealthy\n',
        code: 2,
      },
      containers,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('supabase_storage_magicbooklet-api-tests container logs:\nPGRST_JWT_SECRET=[redacted]\n');
    expect(result.all).not.toContain('Started supabase local development setup.');
    expect(result.stdout).toContain('10.1.0.4:54322');
    expect(result.stdout).toContain('Last 50 log lines of supabase_auth_magicbooklet-api-tests (Up 1 second (health: starting))');
    expect(result.stdout).toContain('Last 50 log lines of supabase_rest_magicbooklet-api-tests (Up 2 minutes (unhealthy))');
    expect(result.stdout).toContain('Last 50 log lines of supabase_storage_magicbooklet-api-tests (Exited (1) 3 seconds ago)');
    expect(result.stdout).toContain('supabase_storage_magicbooklet-api-tests: GOTRUE_JWT_SECRET=[redacted] and [jwt redacted]');
    expect(result.stdout).not.toContain('Last 50 log lines of supabase_db');
    expect(result.stdout).not.toContain('Last 50 log lines of supabase_kong');
    for (const secret of [jwt, secretKey, jwtSecret]) expect(result.all).not.toContain(secret);
  });

  it('prints nothing of the start log, shows db reset\'s output, and hands the tests the status file when the stack starts', () => {
    const result = run(
      { output: 'Starting database...\n', code: 0 },
      { reset: { output: 'Applying migration 20261027000000_stand_in.sql...\nFinished supabase db reset on branch main.\n', code: 0 } },
    );

    expect(result.status).toBe(0);
    expect(result.all).not.toContain('Started supabase local development setup.');
    expect(result.all).not.toContain('Starting database...');
    expect(result.all).not.toContain(secretKey);
    expect(result.stdout).toContain('Applying migration 20261027000000_stand_in.sql...\nFinished supabase db reset on branch main.\n');
    expect(result.calls('docker')).not.toMatch(/^(ps|logs --tail)/m);
    expect(result.calls('timeout')).toContain('5m supabase --workdir');
    expect(result.githubEnv).toBe(`AUDIT_STORAGE_CONFIG=${result.runnerTemp}/supabase-api-status.json\n`);
    expect(readFileSync(path.join(result.runnerTemp, 'supabase-api-status.json'), 'utf8')).toBe('{}\n');
  });
});
