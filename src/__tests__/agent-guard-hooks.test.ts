// @vitest-environment node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The PreToolUse hooks in .claude/settings.json are the only guard on .env* files since 2026-11-01. Deny rules can't
// do it: a Read deny also refused `grep -c '^NAME=' .env.local`, `wc -c` and `stat` (Claude Code 2.1.309), and an
// Edit deny refuses the `printf … >> .env.local` install and the `sed -i` toggle that AGENTS.md prescribes. These
// tests pin what each hook lets through and what it blocks, by feeding it the payload Claude Code sends.

const HOOKS = path.join(process.cwd(), '.claude/hooks');

function hook(file: string, tool_name: string, tool_input: Record<string, unknown>) {
  const result = spawnSync('python3', ['-I', path.join(HOOKS, file)], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input }),
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr };
}

const bash = (command: string) => hook('guard-bash.py', 'Bash', { command });

describe('protect-migrations.py on the file tools', () => {
  it.each<[string, Record<string, unknown>]>([
    ['Read', { file_path: '/repo/.env.local' }],
    ['Read', { file_path: '/repo/ugc-mobile/.env.development.local' }],
    ['Read', { file_path: '/repo/.env' }],
    ['Read', { file_path: '/repo/.mcp.json' }],
    ['Edit', { file_path: '/repo/.env.local', old_string: 'A=1', new_string: 'A=2' }],
    ['Write', { file_path: '/repo/.env.production', content: 'A=1\n' }],
    ['Grep', { pattern: 'KEY', path: '/repo/.env.local' }],
    ['Grep', { pattern: 'KEY', path: '/repo', glob: '**/.env*' }],
  ])('blocks %s on a secrets file (%j)', (tool, input) => {
    const result = hook('protect-migrations.py', tool, input);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('names a secrets file');
    expect(result.stderr).toContain("grep -c '^NAME=' .env.local");
  });

  it.each<[string, Record<string, unknown>]>([
    ['Read', { file_path: '/repo/.env.example' }],
    ['Read', { file_path: '/repo/src/lib/env.ts' }],
    // Reads of an applied migration stay open; only Edit and Write reach the migration rules.
    ['Read', { file_path: '/repo/supabase/migrations/20260101000000_example.sql' }],
    ['Grep', { pattern: 'KEY', path: '/repo/src' }],
    ['Grep', { pattern: 'KEY', path: '/repo', glob: '.env.example' }],
    ['Edit', { file_path: '/repo/src/lib/env.ts', old_string: 'a', new_string: 'b' }],
  ])('lets %s through elsewhere (%j)', (tool, input) => {
    const result = hook('protect-migrations.py', tool, input);
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('guard-bash.py on secrets files', () => {
  it.each([
    "grep -c '^NAME=' .env.local",
    "grep -c '^NAME=' .env.local 2>/dev/null",
    `printf 'NAME=%s\\n' "$(pbpaste)" >> .env.local`,
    `printf 'NAME=%s\\n' "$(pbpaste)" >>"$ROOT/.env.local"`,
    "sed -i '' 's/^#NAME=/NAME=/' .env.local",
    'wc -c .env.local',
    'rm -rf node_modules .env.example',
  ])('allows %s', (command) => {
    const result = bash(command);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['cat .env.local', 'prints a secrets file'],
    ['grep KEY .env.local', 'prints matching lines'],
    ['sed -n 1p .env.local', 'sed without -i'],
    ["echo 'A=1' > .env.local", 'truncates a secrets file'],
    [`printf x >"$ROOT/.env.local"`, 'truncates a secrets file'],
    ['rm .env.local', 'deletes a secrets file'],
    ['cat .mcp.json', 'prints a secrets file'],
  ])('blocks %s', (command, reason) => {
    const result = bash(command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(reason);
  });
});
