// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The repo's shell scripts run on the dev Mac, whose /bin/bash is 3.2. Before bash 4.3 a lone single quote in
// the text of a ${…} expansion within double quotes opens a quoted string, so the android-device skill's
// phone.sh and keep-awake.sh did not parse there at all (`S="${ANDROID_SERIAL:?… the phone's serial …}"`)
// while every newer bash, CI's included, read them fine (2026-10-21). Each script is parsed with the
// interpreter its first line names; the quote trap is also checked by hand, so that CI holds it too.

const ROOT = process.cwd();

function trackedShellScripts(): string[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--', '*.sh'], { cwd: ROOT, encoding: 'utf8' });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout.split('\0').filter(Boolean).sort();
}

/** `bash`, `sh` or `zsh`, from a `#!/bin/bash` or `#!/usr/bin/env bash` first line. */
function interpreterOf(file: string): string {
  const [first = ''] = readFileSync(path.join(ROOT, file), 'utf8').split('\n', 1);
  const [command = '', argument = ''] = first.replace(/^#!\s*/, '').split(/\s+/);
  return path.basename(command) === 'env' ? argument : path.basename(command);
}

/**
 * The text of each `${…}` expansion in a script, nested ones too, without its `$(…)` command substitutions
 * (their quotes have a context of their own, and bash 3.2 parses them: sim.sh's
 * `"${1:-$(… | grep -E 'iPhone' | …)}"`) and with backslash-escaped characters kept as written.
 */
function parameterExpansions(source: string): string[] {
  const expansions: string[] = [];
  for (let start = source.indexOf('${'); start !== -1; start = source.indexOf('${', start + 2)) {
    let braces = 0;
    let substitution = 0;
    let quotedInSubstitution = false;
    let text = '';
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === '\\') {
        if (substitution === 0) text += source.slice(index, index + 2);
        index += 1;
      } else if (substitution > 0) {
        if (char === "'") quotedInSubstitution = !quotedInSubstitution;
        else if (!quotedInSubstitution && char === '(') substitution += 1;
        else if (!quotedInSubstitution && char === ')') substitution -= 1;
      } else if (source.startsWith('$(', index)) {
        substitution = 1;
        index += 1;
      } else if (source.startsWith('${', index)) {
        braces += 1;
        text += '${';
        index += 1;
      } else {
        text += char;
        if (char === '}') {
          braces -= 1;
          if (braces === 0) {
            expansions.push(text);
            break;
          }
        }
      }
    }
  }
  return expansions;
}

/** The expansions bash 3.2 cannot parse: an odd number of unescaped single quotes in their own text. */
function loneQuoteExpansions(source: string): string[] {
  return parameterExpansions(source)
    .filter((text) => (text.replace(/\\./g, '').match(/'/g) ?? []).length % 2 === 1);
}

describe('the shell scripts', () => {
  const scripts = trackedShellScripts();

  it('are found, the android-device skill scripts among them', () => {
    expect(scripts).toEqual(expect.arrayContaining([
      '.agents/skills/android-device/scripts/keep-awake.sh',
      '.agents/skills/android-device/scripts/phone.sh',
    ]));
  });

  // The hand check, on lines whose fate on bash 3.2 is known.
  it('reads a lone quote in an expansion as the trap, and nothing else', () => {
    expect(loneQuoteExpansions(`S="\${ANDROID_SERIAL:?set ANDROID_SERIAL to the phone's serial}"`)).toHaveLength(1);
    expect(loneQuoteExpansions(`X="\${A:-it's $(date)}"`)).toHaveLength(1);
    expect(loneQuoteExpansions(`X="\${A:-a\\}b'c}"`)).toHaveLength(1);
    expect(loneQuoteExpansions(`u="\${1:-$(xcrun simctl list | grep -E 'iPhone' | grep -oE '[0-9A-F-]{36}' | head -1)}"`))
      .toEqual([]);
    expect(loneQuoteExpansions(`x=\${Y:-'a b'}`)).toEqual([]);
    expect(loneQuoteExpansions(`x="\${1:-$(echo ')')}"`)).toEqual([]);
  });

  it('hold no lone single quote in the text of a ${…} expansion, which bash 3.2 reads as an open quote', () => {
    const trapped = scripts
      .filter((file) => ['bash', 'sh'].includes(interpreterOf(file)))
      .flatMap((file) => loneQuoteExpansions(readFileSync(path.join(ROOT, file), 'utf8')).map((text) => `${file}: ${text}`));
    expect(trapped, 'reword the text inside the braces without the apostrophe').toEqual([]);
  });

  it('parse with the interpreter their first line names (the Mac: bash 3.2)', () => {
    const interpreters: Record<string, string> = { bash: '/bin/bash', sh: '/bin/sh', zsh: 'zsh' };
    const failures = scripts.flatMap((file) => {
      const interpreter = interpreters[interpreterOf(file)];
      if (!interpreter) return [`${file}: no interpreter known for "${interpreterOf(file)}"`];
      // zsh is not on CI's runner; the Mac has it.
      if (interpreter === 'zsh' && spawnSync('zsh', ['-c', 'true']).status !== 0) return [];
      const parsed = spawnSync(interpreter, ['-n', path.join(ROOT, file)], { encoding: 'utf8' });
      return parsed.status === 0 ? [] : [`${file}: ${parsed.stderr.trim() || `exit ${parsed.status}`}`];
    });
    expect(failures).toEqual([]);
  });
});
