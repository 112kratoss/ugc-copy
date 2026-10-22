import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One step of a GitHub Actions workflow, read as text, for the tests that pin
 * CI's Expo checks (`expo-install-exclude.test.ts`, `ci-advisory-steps.test.ts`).
 * A step starts at its `      - name:` line (six spaces: a commented-out copy
 * never matches) and ends at the next line indented six spaces or less: the
 * next step, the comment above it, or the next job. Vitest
 * collects only `*.test.ts(x)` under `__tests__/`, so this module runs no
 * tests of its own.
 */
const repoRoot = join(__dirname, '..', '..', '..');
const readWorkflow = (workflow: string) => readFileSync(join(repoRoot, '.github/workflows', workflow), 'utf8');

/** One job, from its `  <id>:` line to the next job's. */
export function workflowJob(workflow: string, id: string): string {
  const text = readWorkflow(workflow);
  const start = text.indexOf(`\n  ${id}:\n`);
  if (start === -1) throw new Error(`${workflow} has no job ${id}`);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}\S/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

export function workflowStep(workflow: string, name: string): string {
  const text = readWorkflow(workflow);
  const start = text.indexOf(`\n      - name: ${name}\n`);
  if (start === -1) throw new Error(`${workflow} has no step named ${name}`);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {0,6}\S/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

/** The step's `run: |` block, dedented as Actions hands it to bash. */
export function stepScript(workflow: string, name: string): string {
  const body = workflowStep(workflow, name).split('        run: |\n')[1];
  if (body === undefined) throw new Error(`${workflow}: ${name} has no run block`);
  return body
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}
