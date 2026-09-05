#!/usr/bin/env node

// What R8 did to the release build, read from AGP's own outputs before an APK
// is installed anywhere.
//
// android/app/build/outputs/mapping/release/ holds these after
// :app:assembleRelease or :app:bundleRelease:
//   mapping.txt        original -> renamed, one class per unindented line
//   seeds.txt          what a keep rule matched (a class, or "class: member")
//   usage.txt          what shrinking removed (a class, or "class:" + indented members)
//   configuration.txt  the merged rules: AGP's defaults, every library's consumer
//                      rules, the generated proguard-rules.pro and
//                      plugins/android-release.pro
//   resources.txt      only with resource shrinking: what it removed and why it kept
//
// It answers the questions docs/android-app-optimization-plan-2026-09-05.md asks
// between a build and a device launch:
//   - the renamed share of classes, the local proxy for Play's obfuscation score
//     (70% locally read as 80% on Play for build 70);
//   - whether every Kotlin record and enumerable that expo-modules-core converts
//     by reflection is still present, and under which name. Build 62 died in that
//     converter ("cannot be cast to type SecureStoreOptions");
//   - whether the merged configuration still carries the rules the app leans on;
//   - what changed for expo.modules.* between two builds (--diff), so a keep-rule
//     edit is reviewed from evidence rather than from a green build.
//
// A clean report is not a pass. The device smoke in the plan is the gate; this is
// what has to be clean before spending the time on it.
//
// Usage:
//   node ./scripts/inspect-r8-output.mjs
//   node ./scripts/inspect-r8-output.mjs --dir android/app/build/outputs/mapping/release
//   node ./scripts/inspect-r8-output.mjs --diff <other outputs dir>
//   node ./scripts/inspect-r8-output.mjs --json
//
// Deliberately not wired to an npm script: package.json is an OTA fingerprint
// input in its entirety (see scripts/verify-ota-target.mjs).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_OUTPUT_DIR = path.join('android', 'app', 'build', 'outputs', 'mapping', 'release');

// The two records that failed in build 62 and the annotation kotlin-reflect reads,
// pinned by name so a scanner regression can never drop them from the report.
export const SENTINEL_TYPES = [
  'expo.modules.securestore.SecureStoreOptions',
  'expo.modules.image.records.ContentPosition',
  'kotlin.Metadata',
];

const RECORD_IMPORT = 'expo.modules.kotlin.records.Record';
const ENUMERABLE_IMPORT = 'expo.modules.kotlin.types.Enumerable';

/** Class lines of mapping.txt: `original -> renamed:`. Members are indented and skipped. */
export function parseMapping(text) {
  const classes = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('#') || line.startsWith(' ')) continue;
    const match = /^(\S+) -> (\S+):$/.exec(line);
    if (match) classes.push({ original: match[1], renamed: match[2] });
  }
  return classes;
}

export function obfuscationShare(classes) {
  const renamed = classes.filter((entry) => entry.original !== entry.renamed).length;
  return {
    total: classes.length,
    renamed,
    share: classes.length === 0 ? 0 : renamed / classes.length,
  };
}

/** seeds.txt: `a.b.C` for a kept class, `a.b.C: <member>` for a kept member. */
export function parseSeeds(text) {
  const classes = new Set();
  const members = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(': ');
    if (separator === -1) {
      classes.add(line);
      continue;
    }
    const className = line.slice(0, separator);
    if (!members.has(className)) members.set(className, []);
    members.get(className).push(line.slice(separator + 2));
  }
  return { classes, members };
}

/** usage.txt: `a.b.C` for a removed class, `a.b.C:` followed by indented removed members. */
export function parseUsage(text) {
  const removedClasses = new Set();
  const removedMembers = new Map();
  let current = null;
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    if (/^\s/.test(rawLine)) {
      if (current) removedMembers.get(current).push(rawLine.trim());
      continue;
    }
    const line = rawLine.trim();
    if (line.endsWith(':')) {
      current = line.slice(0, -1);
      if (!removedMembers.has(current)) removedMembers.set(current, []);
    } else {
      removedClasses.add(line);
      current = null;
    }
  }
  return { removedClasses, removedMembers };
}

/** The rules the app relies on, read from the merged configuration R8 actually ran. */
export function checkConfiguration(text) {
  const has = (pattern) => pattern.test(text);
  const keepattributes = [...text.matchAll(/^-keepattributes\s+([^\n]+)/gm)]
    .flatMap((match) => match[1].split(','))
    .map((attribute) => attribute.trim())
    .filter(Boolean);
  return {
    recordsKept: has(/^-keep\s+class\s+\*\s+implements\s+expo\.modules\.kotlin\.records\.Record\b/m),
    enumerablesKept: has(/^-keep\s+enum\s+\*\s+implements\s+expo\.modules\.kotlin\.types\.Enumerable\b/m),
    kotlinMetadataKept: has(/^-keep\s+class\s+kotlin\.Metadata\b/m),
    blanketExpoKeep: has(/^-keep\s+class\s+expo\.modules\.\*\*\s*\{/m),
    dontoptimize: has(/^-dontoptimize\b/m),
    dontobfuscate: has(/^-dontobfuscate\b/m),
    dontshrink: has(/^-dontshrink\b/m),
    allowaccessmodification: has(/^-allowaccessmodification\b/m),
    repackageclasses: has(/^-repackageclasses\b/m),
    keepattributes: [...new Set(keepattributes)],
  };
}

function skipBalanced(text, start, open, close) {
  let index = start;
  while (index < text.length && text[index] === ' ') index += 1;
  if (text[index] !== open) return start;
  let depth = 0;
  for (; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

const HEADER_END =
  /\{|\}| (?:fun|val|var|class|object|interface|private|internal|public|protected|data|sealed|open|abstract|enum|annotation|companion|typealias|import|package|where|constructor|init|override|inner|lateinit|const|suspend|@)\b/;

/**
 * Class declarations in one Kotlin source file with their supertype list, nested
 * ones as `Outer$Inner` the way mapping.txt spells them — including through
 * `object` and `companion object` bodies (`Outer$Companion$Inner`). Comments and
 * strings are blanked first; `Foo::class` is not a declaration.
 */
export function findKotlinTypes(source) {
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\s+/g, ' ');
  const types = [];
  const enclosing = [];
  let depth = 0;
  let pending = null;
  const token = /\{|\}|(?<!::)\b(?:(enum) )?class (\w+)|\bcompanion object(?: (\w+))?\b|(?<!::)\bobject (\w+)/g;
  let match;
  while ((match = token.exec(text)) !== null) {
    if (match[0] === '{') {
      depth += 1;
      if (pending) {
        enclosing.push({ name: pending, depth });
        pending = null;
      }
      continue;
    }
    if (match[0] === '}') {
      while (enclosing.length > 0 && enclosing[enclosing.length - 1].depth === depth) enclosing.pop();
      depth -= 1;
      continue;
    }
    pending = null;
    const isObject = match[2] === undefined;
    const simpleName = match[2] ?? match[4] ?? match[3] ?? 'Companion';
    const qualified = [...enclosing.map((entry) => entry.name), simpleName].join('$');
    let cursor = match.index + match[0].length;
    cursor = skipBalanced(text, cursor, '<', '>');
    // `class Foo<T> @PublishedApi internal constructor(...)`: modifiers and
    // annotations may sit between the type parameters and the constructor.
    const constructorPrefix = /^(?: @\w+(?:\([^)]*\))?| (?:internal|public|private|protected|constructor))+/.exec(text.slice(cursor));
    if (constructorPrefix) cursor += constructorPrefix[0].length;
    cursor = skipBalanced(text, cursor, '(', ')');
    const rest = text.slice(cursor);
    let supertypes = '';
    let headerLength = 0;
    const colon = /^ ?: /.exec(rest);
    if (colon) {
      const afterColon = rest.slice(colon[0].length);
      const end = afterColon.search(HEADER_END);
      supertypes = (end === -1 ? afterColon : afterColon.slice(0, end)).trim();
      headerLength = colon[0].length + (end === -1 ? afterColon.length : end);
    }
    const hasBody = rest.slice(headerLength).trimStart().startsWith('{');
    types.push({ name: qualified, kind: isObject ? 'object' : match[1] === 'enum' ? 'enum' : 'class', supertypes });
    if (hasBody) {
      pending = simpleName;
      token.lastIndex = cursor + headerLength;
    }
  }
  return types;
}

function* kotlinFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) yield* kotlinFiles(full);
    else if (entry.endsWith('.kt')) yield full;
  }
}

/**
 * Every record and enumerable declared by an installed Expo module, as fully
 * qualified class names. These are the classes expo-modules-core builds through
 * kotlin-reflect at runtime, so they must survive R8 with their members.
 */
export function collectExpoReflectedTypes(root = projectRoot) {
  const modulesDir = path.join(root, 'node_modules');
  const found = new Map();
  if (!existsSync(modulesDir)) return [];
  const packages = readdirSync(modulesDir).filter((name) => name === 'expo' || name.startsWith('expo-'));
  for (const packageName of packages) {
    const sourceRoot = path.join(modulesDir, packageName, 'android', 'src', 'main');
    for (const file of kotlinFiles(sourceRoot)) {
      const source = readFileSync(file, 'utf8');
      const importsRecord = source.includes(RECORD_IMPORT) || source.includes('package expo.modules.kotlin.records');
      const importsEnumerable = source.includes(ENUMERABLE_IMPORT) || source.includes('package expo.modules.kotlin.types');
      if (!importsRecord && !importsEnumerable) continue;
      const packageMatch = /^\s*package\s+([\w.]+)/m.exec(source);
      if (!packageMatch) continue;
      for (const type of findKotlinTypes(source)) {
        if (type.kind === 'object') continue;
        const supertypes = ` ${type.supertypes} `;
        let kind = null;
        if (importsRecord && /[\s,:(]Record[\s,<({]/.test(supertypes)) kind = 'record';
        else if (importsEnumerable && /[\s,:(]Enumerable[\s,<({]/.test(supertypes)) kind = 'enumerable';
        if (!kind) continue;
        const name = `${packageMatch[1]}.${type.name}`;
        found.set(name, { name, kind, package: packageName, file: path.relative(root, file) });
      }
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function readOutputs(dir) {
  const read = (file) => {
    const full = path.join(dir, file);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  };
  const mappingText = read('mapping.txt');
  if (mappingText === null) {
    throw new Error(`No mapping.txt in ${dir}. Run :app:assembleRelease with minification on first.`);
  }
  const classes = parseMapping(mappingText);
  const byOriginal = new Map(classes.map((entry) => [entry.original, entry]));
  const seedsText = read('seeds.txt');
  const usageText = read('usage.txt');
  const configurationText = read('configuration.txt');
  const resourcesText = read('resources.txt');
  return {
    dir,
    mapping: { classes, byOriginal },
    seeds: seedsText === null ? null : parseSeeds(seedsText),
    usage: usageText === null ? null : parseUsage(usageText),
    configuration: configurationText === null ? null : checkConfiguration(configurationText),
    resources: resourcesText === null ? null : summarizeResources(resourcesText),
  };
}

/**
 * resources.txt. AGP 8.12 writes one `Marking <type>:<name>:<id> reachable: …`
 * line per kept resource and, on the classic pipeline, says nothing about the
 * ones it dropped — read removals from the APK's res/ entry count. Older and
 * newer shrinkers add `Skipped unused resource …` / `Removed unused resource …`
 * lines, which are counted when present.
 */
export function summarizeResources(text) {
  const removed = [];
  const reachable = new Map();
  for (const line of text.split('\n')) {
    const kept = /^Marking (\w+):([^:]+):\d+ reachable/.exec(line);
    if (kept) {
      reachable.set(kept[1], (reachable.get(kept[1]) ?? 0) + 1);
      continue;
    }
    const dropped = /^(?:Skipped|Removed) unused resource (\S+?):?(?:\s|$)/.exec(line);
    if (dropped) removed.push(dropped[1]);
  }
  const reachableCount = [...reachable.values()].reduce((sum, count) => sum + count, 0);
  return { reachableCount, reachableByType: Object.fromEntries([...reachable.entries()].sort()), removedCount: removed.length, removed };
}

/**
 * kept-by-name: in mapping.txt under its own name.
 * renamed: in mapping.txt under another name (members may still be intact).
 * removed: listed whole in usage.txt.
 * missing: nowhere. Either the class is not in this program or the scanner
 * spelled it differently; the report says which name it looked for.
 */
export function classStatus(name, outputs) {
  const mapped = outputs.mapping.byOriginal.get(name);
  if (mapped) {
    return mapped.renamed === name
      ? { status: 'kept-by-name' }
      : { status: 'renamed', renamed: mapped.renamed };
  }
  if (outputs.usage?.removedClasses.has(name)) return { status: 'removed' };
  return { status: 'missing' };
}

function resolveNested(name, outputs) {
  // A scanner miss on nesting spells `Outer$Inner` as `Outer.Inner`; compare
  // both sides in dotted form and accept a single unambiguous match.
  const dotted = name.replace(/\$/g, '.');
  const candidates = outputs.mapping.classes
    .map((entry) => entry.original)
    .filter((original) => original.includes('$') && original.replace(/\$/g, '.') === dotted);
  return candidates.length === 1 ? candidates[0] : null;
}

export function buildReport(outputs, reflected = collectExpoReflectedTypes()) {
  const wanted = new Map();
  for (const name of SENTINEL_TYPES) wanted.set(name, { name, kind: 'sentinel' });
  for (const type of reflected) if (!wanted.has(type.name)) wanted.set(type.name, type);

  const survivors = [];
  for (const type of wanted.values()) {
    let lookup = type.name;
    let result = classStatus(lookup, outputs);
    if (result.status === 'missing') {
      const nested = resolveNested(type.name, outputs);
      if (nested) {
        lookup = nested;
        result = classStatus(nested, outputs);
      }
    }
    survivors.push({ name: type.name, kind: type.kind, lookedUp: lookup, ...result });
  }

  const summary = { 'kept-by-name': 0, renamed: 0, removed: 0, missing: 0 };
  for (const survivor of survivors) summary[survivor.status] += 1;

  const expoClasses = {};
  for (const entry of outputs.mapping.classes) {
    if (entry.original.startsWith('expo.modules.')) {
      expoClasses[entry.original] = entry.original === entry.renamed ? 'kept-by-name' : 'renamed';
    }
  }
  if (outputs.usage) {
    for (const removed of outputs.usage.removedClasses) {
      if (removed.startsWith('expo.modules.')) expoClasses[removed] = 'removed';
    }
  }

  const failures = survivors
    .filter((survivor) => (survivor.kind === 'sentinel' ? survivor.status !== 'kept-by-name' : survivor.status === 'removed'))
    .map((survivor) => `${survivor.name}: ${survivor.status}`);

  return {
    dir: outputs.dir,
    share: obfuscationShare(outputs.mapping.classes),
    configuration: outputs.configuration,
    resources: outputs.resources
      ? { reachableCount: outputs.resources.reachableCount, removedCount: outputs.resources.removedCount }
      : null,
    survivors,
    summary,
    expoClasses,
    failures,
  };
}

export function diffReports(before, after) {
  const names = new Set([...Object.keys(before.expoClasses), ...Object.keys(after.expoClasses)]);
  const changed = [];
  for (const name of [...names].sort()) {
    const from = before.expoClasses[name] ?? 'absent';
    const to = after.expoClasses[name] ?? 'absent';
    if (from !== to) changed.push({ name, from, to });
  }
  const configurationChanges = [];
  if (before.configuration && after.configuration) {
    for (const key of Object.keys(after.configuration)) {
      const from = JSON.stringify(before.configuration[key]);
      const to = JSON.stringify(after.configuration[key]);
      if (from !== to) configurationChanges.push({ key, from: before.configuration[key], to: after.configuration[key] });
    }
  }
  return {
    share: { before: before.share, after: after.share },
    configurationChanges,
    changed,
    survivorChanges: after.survivors
      .map((survivor) => {
        const previous = before.survivors.find((entry) => entry.name === survivor.name);
        return previous && previous.status !== survivor.status
          ? { name: survivor.name, from: previous.status, to: survivor.status }
          : null;
      })
      .filter(Boolean),
  };
}

function percent(share) {
  return `${(share * 100).toFixed(1)}%`;
}

export function formatReport(report) {
  const lines = [];
  lines.push(`R8 outputs: ${report.dir}`);
  lines.push(
    `Renamed classes: ${report.share.renamed} of ${report.share.total} (${percent(report.share.share)}) — local proxy for Play's obfuscation score`
  );
  if (report.configuration) {
    const config = report.configuration;
    lines.push('Merged configuration:');
    lines.push(`  records kept (expo-modules-core consumer rule): ${config.recordsKept}`);
    lines.push(`  enumerables kept: ${config.enumerablesKept}`);
    lines.push(`  kotlin.Metadata kept: ${config.kotlinMetadataKept}`);
    lines.push(`  blanket -keep class expo.modules.**: ${config.blanketExpoKeep}`);
    lines.push(`  -dontoptimize: ${config.dontoptimize}   -dontobfuscate: ${config.dontobfuscate}   -dontshrink: ${config.dontshrink}`);
    lines.push(`  -allowaccessmodification: ${config.allowaccessmodification}   -repackageclasses: ${config.repackageclasses}`);
    lines.push(`  -keepattributes: ${config.keepattributes.join(', ') || '(none)'}`);
  } else {
    lines.push('Merged configuration: configuration.txt not found');
  }
  if (report.resources) {
    lines.push(
      `Resource shrinking: ${report.resources.reachableCount} resources marked reachable, ${report.resources.removedCount} listed as removed (AGP 8.12 lists reachability only; count res/ entries in the APK for removals)`
    );
  }
  const expoTotal = Object.keys(report.expoClasses).length;
  const expoCounts = Object.values(report.expoClasses).reduce((acc, status) => {
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(
    `expo.modules.* classes: ${expoTotal} (kept-by-name ${expoCounts['kept-by-name'] ?? 0}, renamed ${expoCounts.renamed ?? 0}, removed ${expoCounts.removed ?? 0})`
  );
  lines.push(
    `Reflected types (records, enumerables, sentinels): ${report.survivors.length} — kept-by-name ${report.summary['kept-by-name']}, renamed ${report.summary.renamed}, removed ${report.summary.removed}, missing ${report.summary.missing}`
  );
  for (const survivor of report.survivors) {
    if (survivor.status === 'kept-by-name') continue;
    const detail = survivor.status === 'renamed' ? ` -> ${survivor.renamed}` : '';
    const lookedUp = survivor.lookedUp !== survivor.name ? ` (matched ${survivor.lookedUp})` : '';
    lines.push(`  ${survivor.status.padEnd(12)} ${survivor.kind.padEnd(10)} ${survivor.name}${detail}${lookedUp}`);
  }
  if (report.failures.length > 0) {
    lines.push('FAIL:');
    for (const failure of report.failures) lines.push(`  ${failure}`);
  } else {
    lines.push('OK: every sentinel is kept by name and no reflected type was removed.');
  }
  return lines.join('\n');
}

export function formatDiff(diff) {
  const lines = [];
  lines.push(
    `Renamed share: ${percent(diff.share.before.share)} -> ${percent(diff.share.after.share)} (${diff.share.before.total} -> ${diff.share.after.total} classes)`
  );
  for (const change of diff.configurationChanges) {
    lines.push(`configuration ${change.key}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`);
  }
  lines.push(`expo.modules.* status changes: ${diff.changed.length}`);
  for (const change of diff.changed.slice(0, 200)) lines.push(`  ${change.from.padEnd(12)} -> ${change.to.padEnd(12)} ${change.name}`);
  if (diff.changed.length > 200) lines.push(`  … ${diff.changed.length - 200} more`);
  lines.push(`Reflected type status changes: ${diff.survivorChanges.length}`);
  for (const change of diff.survivorChanges) lines.push(`  ${change.from} -> ${change.to} ${change.name}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { dir: null, diff: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--dir' || arg === '--diff') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a directory`);
      args[arg.slice(2)] = value;
      index += 1;
    } else if (arg.startsWith('--dir=')) args.dir = arg.slice('--dir='.length);
    else if (arg.startsWith('--diff=')) args.diff = arg.slice('--diff='.length);
    else throw new Error(`Unrecognised argument: ${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(projectRoot, args.dir ?? DEFAULT_OUTPUT_DIR);
  const reflected = collectExpoReflectedTypes(projectRoot);
  const report = buildReport(readOutputs(dir), reflected);
  const diff = args.diff ? diffReports(buildReport(readOutputs(path.resolve(projectRoot, args.diff)), reflected), report) : null;
  if (args.json) {
    console.log(JSON.stringify({ report, diff }, null, 2));
  } else {
    console.log(formatReport(report));
    if (diff) {
      console.log('');
      console.log(`Diff against ${path.resolve(projectRoot, args.diff)}:`);
      console.log(formatDiff(diff));
    }
  }
  process.exitCode = report.failures.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
