// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Since 2026-11-01 the hooks in .claude/settings.json are the only guard on secrets files (.env*, .mcp.json). Deny
// rules can't do it: a Read deny also refused `grep -c '^NAME=' .env.local`, `wc -c` and `stat` (Claude Code
// 2.1.309), and an Edit deny refuses the `printf … >> .env.local` install and the `sed -i` toggle that AGENTS.md
// prescribes. These tests pin how the hooks are wired, and what each lets through and blocks, by feeding it the
// payload Claude Code sends.

const ROOT = process.cwd();
const HOOKS = path.join(ROOT, '.claude/hooks');
const made: string[] = [];

function run(file: string, payload: Record<string, unknown>) {
  const result = spawnSync('python3', ['-I', path.join(HOOKS, file)], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

const fileTool = (tool_name: string, tool_input: Record<string, unknown>) =>
  run('protect-migrations.py', { hook_event_name: 'PreToolUse', tool_name, tool_input });
const bash = (command: string) => run('guard-bash.py', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const prompt = (text: string, cwd = '/repo') => run('guard-prompt.py', { hook_event_name: 'UserPromptSubmit', prompt: text, cwd });

/** A folder holding a decoy .env.local and a symlink named `config` that points at it. */
function decoyWithSymlink() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-hooks-')));
  made.push(dir);
  fs.writeFileSync(path.join(dir, '.env.local'), 'DECOY=1\n');
  fs.symlinkSync(path.join(dir, '.env.local'), path.join(dir, 'config'));
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the hooks in .claude/settings.json', () => {
  type Hook = { type: string; command: string; onFailure?: string };
  type Entry = { matcher?: string; hooks: Hook[] };
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8')) as {
    permissions: { deny: string[] };
    hooks: Record<string, Entry[]>;
  };
  const entry = (event: string, script: string) =>
    settings.hooks[event]?.find((candidate) => candidate.hooks.some((hook) => hook.command.includes(script)));

  it('send every file tool that can read or write a secrets file to protect-migrations.py, failing closed', () => {
    const file = entry('PreToolUse', 'protect-migrations.py');
    expect(file?.matcher?.split('|').sort()).toEqual(['Edit', 'Grep', 'Read', 'Write']);
    expect(file?.hooks[0].onFailure).toBe('block');
  });

  it('send Bash and Monitor commands to guard-bash.py, failing open so a broken python3 leaves Bash for the repair', () => {
    const shell = entry('PreToolUse', 'guard-bash.py');
    expect(shell?.matcher?.split('|').sort()).toEqual(['Bash', 'Monitor']);
    expect(shell?.hooks[0].onFailure).toBeUndefined();
  });

  it('check every prompt for an @-mentioned secrets file', () => {
    expect(entry('UserPromptSubmit', 'guard-prompt.py')).toBeDefined();
  });

  // A Read or Edit deny on .env* would refuse the `grep -c`, `>>` and `sed -i` recipes along with the file tools.
  it('leave .env* to the hooks, with no deny rule on them', () => {
    expect(settings.permissions.deny.filter((rule) => /\.env/i.test(rule))).toEqual([]);
    expect(settings.permissions.deny).toContain('Read(**/.mcp.json)');
  });
});

describe('protect-migrations.py on the file tools', () => {
  it.each<[string, Record<string, unknown>]>([
    ['Read', { file_path: '/repo/.env.local' }],
    ['Read', { file_path: '/repo/ugc-mobile/.env.development.local' }],
    ['Read', { file_path: '/repo/.env' }],
    ['Read', { file_path: '/repo/.ENV.local' }],
    ['Read', { file_path: '/repo/.mcp.json' }],
    ['Edit', { file_path: '/repo/.env.local', old_string: 'A=1', new_string: 'A=2' }],
    ['Edit', { file_path: '/repo/.mcp.json', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '/repo/.env.production', content: 'A=1\n' }],
    ['Grep', { pattern: 'KEY', path: '/repo/.env.local' }],
    ['Grep', { pattern: 'KEY', path: '/repo', glob: '**/.env*' }],
    // ripgrep's --glob overrides .gitignore, so a glob that merely matches .env.local reaches it.
    ['Grep', { pattern: 'KEY', path: '/repo', glob: '*.local' }],
    ['Grep', { pattern: 'KEY', path: '/repo', glob: '.*' }],
  ])('blocks %s on a secrets file (%j)', (tool, input) => {
    const result = fileTool(tool, input);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('names a secrets file');
    expect(result.stderr).toContain("grep -c '^NAME=' .env.local");
  });

  it('blocks a Read through a symlink whose target is a secrets file, as a deny rule did', () => {
    const result = fileTool('Read', { file_path: path.join(decoyWithSymlink(), 'config') });
    expect(result.status, result.stderr).toBe(2);
  });

  it.each<[string, Record<string, unknown>]>([
    ['Read', { file_path: '/repo/.env.example' }],
    ['Write', { file_path: '/repo/.env.example', content: 'NAME=\n' }],
    ['Read', { file_path: '/repo/src/lib/env.ts' }],
    // Reads of an applied migration stay open; only Edit and Write reach the migration rules.
    ['Read', { file_path: '/repo/supabase/migrations/20260101000000_example.sql' }],
    ['Grep', { pattern: 'KEY', path: '/repo/src' }],
    ['Grep', { pattern: 'KEY', path: '/repo', glob: '.env.example' }],
    ['Grep', { pattern: 'KEY', path: '/repo', glob: '*.json' }],
    ['Grep', { pattern: 'KEY', path: '/repo', glob: 'src/**' }],
    ['Edit', { file_path: '/repo/src/lib/env.ts', old_string: 'a', new_string: 'b' }],
  ])('lets %s through elsewhere (%j)', (tool, input) => {
    const result = fileTool(tool, input);
    expect(result.status, result.stderr).toBe(0);
  });

  it('still refuses a migration stamped ahead of the UTC clock', () => {
    const result = fileTool('Write', { file_path: path.join(ROOT, 'supabase/migrations/29991231000000_future.sql'), content: '' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ahead of the UTC clock');
  });
});

describe('guard-prompt.py on prompts', () => {
  it.each([
    'check @.env.local please',
    'is @ugc-app/.env.local, pointing at production?',
    'see @"/Users/athuls/UGC copy/ugc-app/.env.local"',
    '@.mcp.json has the token?',
  ])('blocks a prompt that @-mentions a secrets file: %s', (text) => {
    const result = prompt(text);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('a secrets file');
  });

  it('blocks an @-mention of a symlink to a secrets file', () => {
    expect(prompt('read @config', decoyWithSymlink()).status).toBe(2);
  });

  it.each([
    'copy @.env.example first',
    'mail hello@example.com about .env.local',
    'update @src/lib/env.ts and @supabase/supabase-js',
  ])('lets through: %s', (text) => {
    const result = prompt(text);
    expect(result.status, result.stderr).toBe(0);
  });
});

describe('guard-bash.py on secrets files', () => {
  it.each([
    "grep -c '^NAME=' .env.local",
    "grep --count '^NAME=' .env.local 2>/dev/null",
    `printf 'NAME=%s\\n' "$(pbpaste)" >> .env.local`,
    `printf 'NAME=%s\\n' "$(pbpaste)" >> "/Users/athuls/UGC copy/ugc-app/.env.local"`,
    "sed -i '' 's/^#NAME=/NAME=/' .env.local",
    'wc -c .env.local',
    'chmod 600 .env.local',
    'cp .env.example /tmp/example.env',
    'rm -rf node_modules .env.example',
    'grep -rn "process.env.SUPABASE_URL" src',
    'docker run --rm --env-file .env.local node:24 true',
    'echo ok >| /tmp/out',
    'wc -l < src/lib/env.ts',
    "grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local",
    "openssl rand -hex 32 | sed 's/^/KIE_WEBHOOK_SECRET=/' >> .env.local",
    "sed -Ei '' 's/^#(NAME=)/\\1/' .env.local",
    "git grep -n -E 'grep .*\\.env' -- '*.md'",
  ])('allows %s', (command) => {
    const result = bash(command);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ['cat .env.local', 'prints a secrets file'],
    ['cat .mcp.json', 'prints a secrets file'],
    ['cat \\\n  .env.local', 'prints a secrets file'],
    ['grep KEY .env.local', 'searching a secrets file'],
    ['rg -n SERVICE_ROLE .env.local', 'searching a secrets file'],
    // A separator inside quotes is part of the argument, not the end of the command.
    ["grep -E 'KIE_API_KEY|SUPABASE_SERVICE_ROLE_KEY' .env.local", 'searching a secrets file'],
    ['grep -e SUPABASE_URL -e SUPABASE_SERVICE_ROLE_KEY .env.local', 'searching a secrets file'],
    ["sed -n '1p;3p' .env.local", 'sed without -i'],
    ['sed -n 1p .env.local', 'sed without -i'],
    ['jq -R . .env.local', 'prints a secrets file'],
    ['cat 2>&1 .env.local', 'prints a secrets file'],
    ['sleep 1 & cat .env.local', 'prints a secrets file'],
    [`printf 'A=1\\n' > "$CLAUDE_PROJECT_DIR"/.env.local`, 'truncates a secrets file'],
    ["echo 'A=1' > .env.local", 'truncates a secrets file'],
    ['echo A=1 > "/Users/athuls/UGC copy/ugc-app/.env.local"', 'truncates a secrets file'],
    ['echo x > "$(git rev-parse --show-toplevel)/.env.local"', 'truncates a secrets file'],
    ['echo x >| .env.local', 'truncates a secrets file'],
    ['echo x &> .env.local', 'truncates a secrets file'],
    ["tr 'a-z' 'A-Z' < .env.local", 'reads a secrets file'],
    ['echo "$(< .env.local)"', 'reads a secrets file'],
    ['rm .env.local', 'overwrites a secrets file'],
    ['cp .env.example .env.local', 'overwrites a secrets file'],
    ['mv .env.local /tmp/x', 'overwrites a secrets file'],
    ['find . -name .env.local -delete', 'overwrites a secrets file'],
  ])('blocks %s', (command, reason) => {
    const result = bash(command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(reason);
  });

  it('refuses a secrets command when its own check fails, and lets other commands through', () => {
    const broken = (command: unknown) =>
      spawnSync('python3', ['-I', path.join(HOOKS, 'guard-bash.py')], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' });
    expect(broken(['cat', '.env.local']).status).toBe(2);
    expect(broken(['ls']).status).toBe(0);
  });
});
