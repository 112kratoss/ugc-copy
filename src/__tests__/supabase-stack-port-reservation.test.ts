// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// Quality's Supabase jobs died at `supabase start` when an outbound connection on the runner had been given one of
// the stack's host ports as its local port: 54324 on 2026-10-29, held in TIME-WAIT, and 54322 on 2026-10-04. The
// ports sit inside Linux's ephemeral range, so every job that starts the stack reserves them as its first step. These
// read the workflows and the two config files, and run that step's bash as Actions does (`bash -e`), with sudo and
// sysctl stood in for.

const STEP = "Reserve the Supabase stack's ports";
// Linux's default ip_local_port_range, from which the kernel picks a connection's local port; the step prints the
// runner's.
const EPHEMERAL_LOW = 32768;
const EPHEMERAL_HIGH = 60999;

const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

/** Every port a config file sets, comments aside, that the kernel could give an outbound connection. */
function configuredPorts(file: string) {
  return [...read(file).matchAll(/^[ \t]*\w*port[ \t]*=[ \t]*(\d+)/gm)]
    .map((match) => Number(match[1]))
    .filter((port) => port >= EPHEMERAL_LOW && port <= EPHEMERAL_HIGH);
}

/** The ports a list such as `54320-54322,54327` names, in order, once each. */
function ports(list: string) {
  const named = list.split(',').filter(Boolean).flatMap((part) => {
    const [low, high = low] = part.split('-').map(Number);
    return Array.from({ length: high - low + 1 }, (_, offset) => low + offset);
  });
  return [...new Set(named)].sort((a, b) => a - b);
}

type Job = { name: string; steps: string[] };

/** Every job of every workflow, with each of its steps as the text from its `- ` to the next step. */
function workflowJobs(): Job[] {
  const folder = '.github/workflows';
  return readdirSync(path.join(process.cwd(), folder)).filter((file) => file.endsWith('.yml')).flatMap((file) => {
    const workflow = read(`${folder}/${file}`);
    return workflow.slice(workflow.indexOf('\njobs:\n') + 1).split(/\n(?= {2}[\w-]+:\n)/).slice(1).map((job) => {
      const steps = job.slice(Math.max(job.indexOf('\n    steps:\n'), 0));
      return { name: `${file} ${job.match(/^ {2}([\w-]+):/)?.[1]}`, steps: steps.split(/\n(?= {6}- )/).slice(1) };
    });
  });
}

/** A step's `run: |` block, dedented as Actions hands it to bash. */
function runBlock(step: string) {
  const lines = (step.split('        run: |\n')[1] ?? '').split('\n');
  const end = lines.findIndex((line) => line.trim() !== '' && !line.startsWith(' '.repeat(10)));
  return `${lines.slice(0, end === -1 ? undefined : end).map((line) => line.slice(10)).join('\n').trimEnd()}\n`;
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// sudo runs what follows -n; sysctl reads the reservation as $RESERVED until a -w writes one, and prints the
// reservation and the default ephemeral range by name.
const STUBS: Record<string, string> = {
  sudo: `echo "$*" >> "$STUB_DIR/sudo-calls"
[ "$1" = -n ] && shift
exec "$@"`,
  sysctl: `reserved() { cat "$STUB_DIR/reserved" 2> /dev/null || printf '%s\\n' "$RESERVED"; }
case " $* " in
  *' -w '*) for arg; do case "$arg" in *=*) printf '%s\\n' "\${arg#*=}" > "$STUB_DIR/reserved" ;; esac; done ;;
  *' -n '*) reserved ;;
  *) for name; do
       case "$name" in
         net.ipv4.ip_local_reserved_ports) echo "$name = $(reserved)" ;;
         net.ipv4.ip_local_port_range) printf '%s = 32768\\t60999\\n' "$name" ;;
       esac
     done ;;
esac`,
};

function reserve(step: string, reserved = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'supabase-port-reservation-'));
  made.push(dir);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  const result = spawnSync('bash', ['-e', '-c', runBlock(step)], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, STUB_DIR: dir, RESERVED: reserved },
    encoding: 'utf8',
    timeout: 10_000,
  });
  const file = (name: string) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : '');
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, written: file('reserved').trim(), sudo: file('sudo-calls') };
}

const stackJobs = workflowJobs().filter((job) => job.steps.some((step) => /^[^#\n]*\bsupabase\b[^#\n]*\sstart\b/m.test(step)));
const stackPorts = ports([
  ...configuredPorts('supabase/config.toml'),
  ...configuredPorts('supabase/config.api-tests.toml'),
].join(','));

describe("the Supabase stack's port reservation", () => {
  it('reads the ports from both config files, the mail catcher\'s, analytics\' and the pooler\'s among them', () => {
    expect(stackPorts).toEqual(expect.arrayContaining([54321, 54322, 54324, 54327, 54329]));
  });

  it('finds the jobs that start the stack', () => {
    expect(stackJobs.map((job) => job.name)).toEqual(expect.arrayContaining([
      'quality.yml supabase-api',
      'quality.yml supabase-migrations',
      'schema-baseline.yml replay',
    ]));
  });

  it('reserves exactly the configured ports, through sudo, as the first step of every job that starts the stack, and prints the result', () => {
    for (const job of stackJobs) {
      const [first = ''] = job.steps;
      expect(first.split('\n')[0], job.name).toBe(`      - name: ${STEP}`);
      const result = reserve(first);

      expect(result.status, `${job.name}: ${result.stderr}`).toBe(0);
      expect(ports(result.written), job.name).toEqual(stackPorts);
      expect(result.sudo, job.name).toMatch(/^-n sysctl .*-w net\.ipv4\.ip_local_reserved_ports=/m);
      expect(result.stdout, job.name).toContain(`net.ipv4.ip_local_reserved_ports = ${result.written}\n`);
      expect(result.stdout, job.name).toContain('net.ipv4.ip_local_port_range = ');
    }
  });

  it('keeps the ports the runner image already reserves', () => {
    const result = reserve(stackJobs[0].steps[0], '1024,30000-30010');

    expect(result.written.startsWith('1024,30000-30010,')).toBe(true);
    expect(ports(result.written)).toEqual(ports(['1024,30000-30010', ...stackPorts].join(',')));
  });
});
