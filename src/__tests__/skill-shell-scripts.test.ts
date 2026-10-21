// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The skills' shell scripts run on the dev Mac, whose /bin/bash is 3.2. Before
// bash 4.3 a single quote inside a ${…} expansion within double quotes opens a
// quoted string, so phone.sh and keep-awake.sh did not parse there at all
// (`S="${ANDROID_SERIAL:?set ANDROID_SERIAL to the phone's serial …}"`) while
// every newer bash, CI's included, read them fine (2026-10-21).

const SKILLS_ROOT = path.join(process.cwd(), '.agents', 'skills');

function shellScripts(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return shellScripts(entryPath);
    return entry.name.endsWith('.sh') ? [entryPath] : [];
  });
}

/**
 * The text of each `${…}` expansion in a script, nested ones too, with its `$(…)` command
 * substitutions left out: quotes in those have a context of their own, and bash 3.2 parses them
 * (sim.sh's `"${1:-$(… | grep -E 'iPhone' | …)}"`). It fails on a quote in the expansion's own
 * text: `"${X:-it's}"` and `"${X:?the phone's serial}"` alike.
 */
function parameterExpansions(source: string): string[] {
  const expansions: string[] = [];
  for (let start = source.indexOf('${'); start !== -1; start = source.indexOf('${', start + 2)) {
    let braces = 0;
    let substitution = 0;
    let text = '';
    for (let index = start; index < source.length; index += 1) {
      if (substitution > 0) {
        if (source[index] === '(') substitution += 1;
        if (source[index] === ')') substitution -= 1;
        continue;
      }
      if (source.startsWith('$(', index)) {
        substitution = 1;
        index += 1;
        continue;
      }
      if (source.startsWith('${', index)) {
        braces += 1;
        text += '${';
        index += 1;
        continue;
      }
      text += source[index];
      if (source[index] === '}') {
        braces -= 1;
        if (braces === 0) {
          expansions.push(text);
          break;
        }
      }
    }
  }
  return expansions;
}

describe("the skills' shell scripts", () => {
  const scripts = shellScripts(SKILLS_ROOT);
  const named = (file: string) => path.relative(SKILLS_ROOT, file);

  it('are all found', () => {
    expect(scripts.map(named)).toEqual(expect.arrayContaining([
      'android-device/scripts/emulator.sh',
      'android-device/scripts/keep-awake.sh',
      'android-device/scripts/phone.sh',
      'local-checks/scripts/run.sh',
    ]));
  });

  // Held on every machine: CI's bash is newer and parses such a line.
  it('hold no single quote inside a ${…} expansion, which bash 3.2 reads as an open quote', () => {
    const quoted = scripts.flatMap((file) => parameterExpansions(readFileSync(file, 'utf8'))
      .filter((expansion) => expansion.includes("'"))
      .map((expansion) => `${named(file)}: ${expansion}`));
    expect(quoted, 'reword the text inside the braces without an apostrophe').toEqual([]);
  });

  it.skipIf(!existsSync('/bin/bash'))("parse with this machine's /bin/bash (3.2 on the dev Mac)", () => {
    const failures = scripts.flatMap((file) => {
      try {
        execFileSync('/bin/bash', ['-n', file], { stdio: 'pipe' });
        return [];
      } catch (error) {
        const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
        return [`${named(file)}: ${stderr || String(error)}`];
      }
    });
    expect(failures).toEqual([]);
  });
});
