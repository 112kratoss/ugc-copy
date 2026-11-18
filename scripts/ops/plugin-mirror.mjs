#!/usr/bin/env node
// Publishes the Claude Code plugin marketplace to its public repository.
//
// The marketplace (`.claude-plugin/`) and its plugin (`plugins/magicbooklet/`) are kept in this
// repository, beside the server they drive, where `mcp-distribution-manifests.test.ts` holds them
// to it. People install from a public repository of their own, named by the plugin manifest's
// `repository`, so installs do not depend on this repository being public. That repository is
// output only: the tracked files of the two folders at the same paths, and the plugin's README
// again at the root.
//
//   npm run ops:plugin-mirror -- check            # exit 1 when the public repository differs
//   npm run ops:plugin-mirror -- push             # show what a push would change, and stop
//   npm run ops:plugin-mirror -- push --confirm   # commit and push it
//
// A push is publication: run it with --confirm only on the owner's word. It refuses a tree that
// holds anything that reads as a secret or a private identifier, and a tree whose two folders
// have uncommitted changes, so what is published is what a commit here holds.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folders that are published, at the same paths. */
export const MIRROR_FOLDERS = ['.claude-plugin', 'plugins'];
const PLUGIN_MANIFEST = 'plugins/magicbooklet/.claude-plugin/plugin.json';
/** The plugin's README, which the public repository also shows at its root. */
const ROOT_README_SOURCE = 'plugins/magicbooklet/README.md';
const MIRROR_BRANCH = 'main';
/** The public repository's commits carry the product's public address, never the operator's own. */
const COMMIT_IDENTITY = ['-c', 'user.name=Magic Booklet', '-c', 'user.email=info@magicbooklet.com'];
const PUBLIC_EMAILS = new Set(['info@magicbooklet.com']);

/** What must never be published. Each is checked against every file's text. */
const PRIVATE_CONTENT = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a signed token', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/],
  ['a provider key', /\b(?:sk_(?:live|test)_|rzp_(?:live|test)_|sb_secret_|ghp_|github_pat_|xox[abprs]-|AKIA[0-9A-Z]{16})/],
  ['the service role', /service_role/i],
  ['a Supabase project host', /\b[a-z0-9]{20}\.supabase\.co\b/],
  ['a path on someone’s machine', /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+/],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function git(args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr.trim()}`);
  }
  return result;
}

function trackedFiles(cwd, paths = []) {
  return git(['ls-files', '-z', '--', ...paths], cwd).stdout.split('\0').filter(Boolean).sort();
}

/**
 * The public repository's whole tree as this checkout would publish it: path → bytes. Only files
 * git tracks are read, so nothing a tool left in the folders (a `.DS_Store`, a note) is published.
 */
export function mirrorFiles(root) {
  const files = new Map();
  for (const file of trackedFiles(root, MIRROR_FOLDERS)) {
    const stat = fs.lstatSync(path.join(root, file));
    // A link could point anywhere in the checkout; only plain files are published.
    if (!stat.isFile()) throw new Error(`${file} is not a plain file, so it cannot be published.`);
    files.set(file, fs.readFileSync(path.join(root, file)));
  }
  if (!files.has(ROOT_README_SOURCE)) throw new Error(`${ROOT_README_SOURCE} is missing.`);
  files.set('README.md', files.get(ROOT_README_SOURCE));
  return new Map([...files].sort(([left], [right]) => (left < right ? -1 : 1)));
}

/** `owner/name` of the public repository, as the plugin manifest names it. */
export function mirrorRepository(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, PLUGIN_MANIFEST), 'utf8'));
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/.exec(manifest.repository ?? '');
  if (!match) throw new Error(`${PLUGIN_MANIFEST} names no GitHub repository.`);
  return match[1];
}

/** Why a tree must not be published, one line per finding; empty when it may be. */
export function findPrivateContent(files) {
  const problems = [];
  for (const [file, bytes] of files) {
    const segments = file.split('/');
    if (segments.some((segment) => /^\.env/i.test(segment) || segment === '.mcp.json')) {
      problems.push(`${file}: a secrets file`);
      continue;
    }
    const text = bytes.toString('utf8');
    for (const [label, pattern] of PRIVATE_CONTENT) {
      if (pattern.test(text)) problems.push(`${file}: ${label}`);
    }
    for (const email of text.match(EMAIL) ?? []) {
      if (!PUBLIC_EMAILS.has(email.toLowerCase())) {
        problems.push(`${file}: an email address that is not the public one`);
        break;
      }
    }
  }
  return problems;
}

/** What publishing `wanted` over `published` would do: paths added, changed and removed. */
export function mirrorDifference(published, wanted) {
  const added = [...wanted.keys()].filter((file) => !published.has(file));
  const removed = [...published.keys()].filter((file) => !wanted.has(file));
  const changed = [...wanted.keys()].filter((file) => published.has(file) && !published.get(file).equals(wanted.get(file)));
  return { added, changed, removed, same: added.length + changed.length + removed.length === 0 };
}

function clonePublished(repository, directory) {
  git(['clone', '--quiet', '--depth', '1', `https://github.com/${repository}.git`, directory], process.cwd());
  const files = new Map();
  for (const file of trackedFiles(directory)) files.set(file, fs.readFileSync(path.join(directory, file)));
  return files;
}

function printDifference(difference) {
  for (const [label, list] of [['add', difference.added], ['change', difference.changed], ['remove', difference.removed]]) {
    for (const file of list) console.log(`  ${label}  ${file}`);
  }
}

function main() {
  const [mode, ...flags] = process.argv.slice(2);
  if ((mode !== 'check' && mode !== 'push') || flags.some((flag) => flag !== '--confirm') || (mode === 'check' && flags.length > 0)) {
    console.error('usage: plugin-mirror.mjs check | push [--confirm]');
    process.exit(2);
  }
  const root = git(['rev-parse', '--show-toplevel'], path.dirname(fileURLToPath(import.meta.url))).stdout.trim();
  const repository = mirrorRepository(root);
  const wanted = mirrorFiles(root);
  const version = JSON.parse(wanted.get(PLUGIN_MANIFEST).toString('utf8')).version;

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mirror-'));
  try {
    const difference = mirrorDifference(clonePublished(repository, directory), wanted);
    if (difference.same) {
      console.log(`${repository} holds plugin ${version} as this checkout has it.`);
      return;
    }
    console.log(`${repository} differs from this checkout (plugin ${version}):`);
    printDifference(difference);
    if (mode === 'check') {
      process.exitCode = 1;
      return;
    }

    const problems = findPrivateContent(wanted);
    if (problems.length > 0) {
      console.error(`Not published. The tree holds what must stay private:\n  ${problems.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    const uncommitted = git(['status', '--porcelain', '--', ...MIRROR_FOLDERS], root).stdout.trim();
    if (uncommitted) {
      console.error(`Not published. Commit or drop these first, so what is published is what a commit holds:\n${uncommitted}`);
      process.exitCode = 1;
      return;
    }
    if (!flags.includes('--confirm')) {
      console.log('Nothing was pushed. A push is publication: run it again with --confirm on the owner’s word.');
      return;
    }

    // A repository with no commit yet clones with no branch; either way the commit lands on main.
    git(['checkout', '--quiet', '-B', MIRROR_BRANCH], directory);
    for (const file of difference.removed) fs.rmSync(path.join(directory, file));
    for (const file of [...difference.added, ...difference.changed]) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), wanted.get(file));
    }
    git(['add', '--all'], directory);
    git([...COMMIT_IDENTITY, 'commit', '--quiet', '-m', `Magic Booklet plugin ${version}`], directory);
    git(['push', '--quiet', 'origin', MIRROR_BRANCH], directory);
    console.log(`Published plugin ${version} to ${repository} at ${git(['rev-parse', 'HEAD'], directory).stdout.trim()}.`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
