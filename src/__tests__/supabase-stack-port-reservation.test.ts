// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// Quality's Supabase jobs died at `supabase start` when an outbound connection on the runner had been given one of
// the stack's host ports as its local port: 54324 on 2026-10-29, held in TIME-WAIT, and 54322 on 2026-10-04. The
// ports sit inside Linux's ephemeral range, so every job that starts the stack reserves them as its first step. These
// read the workflows and the two config files, and run that step's bash as Actions does (`bash -e`), with sudo,
// sysctl and ss stood in for. The sysctl stand-in refuses what the kernel and procps refuse, so a list the runner
// would reject fails here too.

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

/** The ports a list such as `54320-54322,54327` names, in order, once each. Anything else throws. */
function ports(list: string) {
  const named = list.split(',').flatMap((part) => {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) throw new Error(`"${part}" in "${list}" is neither a port nor a range`);
    const [low, high] = [Number(range[1]), Number(range[2] ?? range[1])];
    return Array.from({ length: high - low + 1 }, (_, offset) => low + offset);
  });
  return [...new Set(named)].sort((a, b) => a - b);
}

type Job = { name: string; steps: string[] };

const WORKFLOWS = '.github/workflows';
const workflowFiles = readdirSync(path.join(process.cwd(), WORKFLOWS)).filter((file) => /\.ya?ml$/.test(file)).sort();

/** Every job of every workflow, with each of its steps as the text from its `- ` to the next step. */
function workflowJobs(): Job[] {
  return workflowFiles.flatMap((file) => {
    const workflow = read(`${WORKFLOWS}/${file}`);
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

// sudo runs what follows -n. sysctl knows the two keys the step names: as procps does on the kernel's EINVAL or on a
// missing key, it fails on a list the kernel's parser refuses (anything but ports and ranges joined by single commas,
// one trailing comma allowed) and on any other argument, and it holds a written list as the kernel prints back one
// already in order. ss prints $SOCKETS.
const STUBS: Record<string, string> = {
  sudo: `echo "$*" >> "$STUB_DIR/sudo-calls"
[ "$1" = -n ] && shift
exec "$@"`,
  sysctl: `for arg; do
  case "$arg" in
    -*) ;;
    net.ipv4.ip_local_reserved_ports=*)
      value="\${arg#*=}"
      if ! printf '%s' "$value" | grep -Eqx '[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*,?'; then
        echo 'sysctl: setting key "net.ipv4.ip_local_reserved_ports": Invalid argument' >&2
        exit 1
      fi
      printf '%s\\n' "\${value%,}" > "$STUB_DIR/reserved" ;;
    net.ipv4.ip_local_reserved_ports) echo "$arg = $(cat "$STUB_DIR/reserved" 2> /dev/null)" ;;
    net.ipv4.ip_local_port_range) printf '%s = 32768\\t60999\\n' "$arg" ;;
    *)
      echo "sysctl: cannot stat /proc/sys/$(printf '%s' "\${arg%%=*}" | tr . /): No such file or directory" >&2
      exit 1 ;;
  esac
done`,
  ss: `echo "$*" >> "$STUB_DIR/ss-calls"
printf '%s' "$SOCKETS"`,
};

const HELD = 'TIME-WAIT 0      0      10.1.0.4:54322     3.5.6.7:443\n';

function reserve(script: string, sockets = HELD) {
  const dir = mkdtempSync(path.join(tmpdir(), 'supabase-port-reservation-'));
  made.push(dir);
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(path.join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }
  const result = spawnSync('bash', ['-e', '-c', script], {
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`, STUB_DIR: dir, SOCKETS: sockets },
    encoding: 'utf8',
    timeout: 10_000,
  });
  const file = (name: string) => (existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : '');
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    written: file('reserved').trim(),
    sudo: file('sudo-calls'),
    ss: file('ss-calls'),
  };
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

  it('finds the jobs that start the stack, reading jobs from every workflow file', () => {
    const jobs = workflowJobs();
    for (const file of workflowFiles) expect(jobs.some((job) => job.name.startsWith(`${file} `)), file).toBe(true);
    expect(stackJobs.map((job) => job.name)).toEqual(expect.arrayContaining([
      'quality.yml supabase-api',
      'quality.yml supabase-migrations',
      'schema-baseline.yml replay',
    ]));
  });

  // One step run per test: a run is several processes, and CI's runner can be slow.
  it.each(stackJobs)('$name reserves exactly the configured ports, through sudo, as its first step, and prints the result and the sockets it cannot move', (job) => {
    const [first = ''] = job.steps;
    expect(first.split('\n')[0]).toBe(`      - name: ${STEP}`);
    const result = reserve(runBlock(first));

    expect(result.status, result.stderr).toBe(0);
    expect(ports(result.written)).toEqual(stackPorts);
    expect(result.sudo).toMatch(/^-n sysctl .*-w net\.ipv4\.ip_local_reserved_ports=/m);
    expect(result.stdout).toContain(`net.ipv4.ip_local_reserved_ports = ${result.written}\n`);
    expect(result.stdout).toContain('net.ipv4.ip_local_port_range = 32768\t60999\n');
    expect(result.ss).toBe(`-Htan ( sport >= :${stackPorts[0]} and sport <= :${stackPorts[stackPorts.length - 1]} )\n`);
    expect(result.stdout).toContain(`which the reservation cannot move:\n${HELD}`);
  });

  it('says so when no socket holds a stack port', () => {
    expect(reserve(runBlock(stackJobs[0].steps[0]), '').stdout).toContain('which the reservation cannot move:\nnone\n');
  });

  // The stand-in's half of the comparison: a step it passes must be one the runner's kernel takes, and the other way
  // round. Each edited list is quoted, so it reaches sysctl as one argument.
  const withList = (edit: (list: string) => string) => {
    const script = runBlock(stackJobs[0].steps[0]);
    const list = /ip_local_reserved_ports=(\S+)/.exec(script)?.[1] ?? '';
    expect(edit(list)).not.toBe(list);
    return script.replace(`ip_local_reserved_ports=${list}`, `ip_local_reserved_ports="${edit(list)}"`);
  };

  it.each([
    ['a leading comma', (list: string) => `,${list}`],
    ['a space after a comma', (list: string) => list.replace(',', ', ')],
    ['an empty item', (list: string) => list.replace(',', ',,')],
  ])('fails the step, as the runner does, on a list with %s', (_, edit) => {
    const result = reserve(withList(edit));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"net.ipv4.ip_local_reserved_ports": Invalid argument');
  });

  it('takes a list with a trailing comma, as the kernel does, and holds it without one', () => {
    const result = reserve(withList((list) => `${list},`));

    expect(result.status, result.stderr).toBe(0);
    expect(ports(result.written)).toEqual(stackPorts);
    expect(result.stdout).toContain(`net.ipv4.ip_local_reserved_ports = ${result.written}\n`);
    expect(result.written.endsWith(',')).toBe(false);
  });

  it('fails the step, as the runner does, on a key that does not exist', () => {
    const script = runBlock(stackJobs[0].steps[0]);
    const misspelled = script.replace('sysctl net.ipv4.ip_local_reserved_ports ', 'sysctl net.ipv4.ip_local_reserved_port ');
    expect(misspelled).not.toBe(script);
    const result = reserve(misspelled);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot stat /proc/sys/net/ipv4/ip_local_reserved_port:');
  });
});
