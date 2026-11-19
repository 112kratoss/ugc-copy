#!/usr/bin/env node
// Publishes the Claude Code plugin marketplace to its public repository.
//
// The marketplace (`.claude-plugin/`) and its plugin (`plugins/magicbooklet/`) are kept in this
// repository, beside the server they drive, where `mcp-distribution-manifests.test.ts` holds them
// to it. People install from a public repository of their own, named by the plugin manifest's
// `repository`, so installs do not depend on this repository being public. That repository is
// output only: the files of the two folders at the same paths, and the plugin's README again at
// the root. Anything else found there stops a push.
//
//   npm run ops:plugin-mirror -- check            # exit 1 when the public repository differs
//   npm run ops:plugin-mirror -- push             # show what a push would change, and stop
//   npm run ops:plugin-mirror -- push --confirm   # commit and push it
//
// What is published is a commit, never the working tree: `origin/main` as a fetch just found it,
// or the commit `--ref <ref>` names (a change that must be public before it is merged). So a
// stale checkout, another branch or an uncommitted edit cannot reach the public repository.
//
// A push is publication: run it with --confirm only on the owner's word. It refuses a tree that
// holds anything that reads as a secret or a private identifier, a plugin whose files changed
// while its version did not, and a manifest that names this repository itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folders that are published, at the same paths. */
export const MIRROR_FOLDERS = ['.claude-plugin', 'plugins'];
const PLUGIN_MANIFEST = 'plugins/magicbooklet/.claude-plugin/plugin.json';
/** The plugin's README, which the public repository also shows at its root. */
const ROOT_README = 'README.md';
const ROOT_README_SOURCE = 'plugins/magicbooklet/README.md';
const MIRROR_BRANCH = 'main';
const DEFAULT_REF = 'origin/main';
/**
 * The public repository's commits carry the product's public address, never the operator's own.
 * Git reads these variables before any configuration, so an identity exported in the operator's
 * shell cannot replace them; signing and hooks are off so no key or hook of theirs takes part.
 */
const COMMIT_ENVIRONMENT = {
  GIT_AUTHOR_NAME: 'Magic Booklet',
  GIT_AUTHOR_EMAIL: 'info@magicbooklet.com',
  GIT_COMMITTER_NAME: 'Magic Booklet',
  GIT_COMMITTER_EMAIL: 'info@magicbooklet.com',
};
const COMMIT_CONFIGURATION = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];
const PUBLIC_EMAILS = new Set(['info@magicbooklet.com']);

/** What must never be published. Each is checked against every file's text. */
const PRIVATE_CONTENT = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a signed token', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/],
  ['a provider key', /\b(?:sk[-_][A-Za-z0-9_-]{12,}|rzp_(?:live|test)_|sb_secret_|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_|xox[abprs]-|AKIA[0-9A-Z]{16})/],
  ['a long hex key', /\b[0-9a-f]{32,}\b/i],
  ['the service role', /service_role/i],
  ['a Supabase project host', /\b[a-z0-9]{20}\.supabase\.co\b|pooler\.supabase\.com/],
  ['a path on someone’s machine', /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+/],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function git(args, cwd, { env, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, { cwd, encoding, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${String(result.stderr).trim()}`);
  return result.stdout;
}

function trackedFiles(cwd, paths = []) {
  return git(['ls-files', '-z', '--', ...paths], cwd).split('\0').filter(Boolean).sort();
}

/**
 * The public repository's whole tree, path → bytes, as a commit holds it (`ref`) or, with no
 * `ref`, as this checkout's tracked files do (what the tests read). Only files git tracks are
 * read, so nothing a tool left in the folders is published, and only plain files: a link could
 * point anywhere, and an executable would be published without its mode, so both stop here until
 * the script learns to carry them.
 */
export function mirrorFiles(root, ref) {
  const files = new Map();
  if (ref) {
    const entries = git(['ls-tree', '-r', '-z', ref, '--', ...MIRROR_FOLDERS], root).split('\0').filter(Boolean);
    for (const entry of entries) {
      const [meta, file] = entry.split('\t');
      const [mode, type, object] = meta.split(' ');
      if (type !== 'blob' || mode !== '100644') throw new Error(`${file} is not a plain file (mode ${mode}), so it cannot be published.`);
      files.set(file, git(['cat-file', 'blob', object], root, { encoding: 'buffer' }));
    }
  } else {
    for (const file of trackedFiles(root, MIRROR_FOLDERS)) {
      const stat = fs.lstatSync(path.join(root, file));
      if (!stat.isFile() || (stat.mode & 0o111) !== 0) throw new Error(`${file} is not a plain file, so it cannot be published.`);
      files.set(file, fs.readFileSync(path.join(root, file)));
    }
  }
  if (!files.has(ROOT_README_SOURCE)) throw new Error(`${ROOT_README_SOURCE} is missing.`);
  files.set(ROOT_README, files.get(ROOT_README_SOURCE));
  return new Map([...files].sort(([left], [right]) => (left < right ? -1 : 1)));
}

function pluginManifest(files) {
  const bytes = files.get(PLUGIN_MANIFEST);
  return bytes ? JSON.parse(bytes.toString('utf8')) : null;
}

/** `owner/name` of the public repository, as the tree's plugin manifest names it. */
export function mirrorRepository(files) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/.exec(pluginManifest(files)?.repository ?? '');
  if (!match) throw new Error(`${PLUGIN_MANIFEST} names no GitHub repository.`);
  return match[1];
}

/** `owner/name` from a GitHub remote's URL, in either form git writes it. */
export function repositoryOfRemote(url) {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1] ?? null;
}

/** Whether a path belongs in the public repository at all. */
export function isMirrorPath(file) {
  return file === ROOT_README || MIRROR_FOLDERS.some((folder) => file.startsWith(`${folder}/`));
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

/**
 * An installed copy updates only when the plugin's version changes, so a plugin whose files
 * differ from the published ones under the same version would reach nobody who has it. The
 * marketplace's own file is read fresh on every update and needs no version.
 */
export function versionProblem(published, wanted) {
  const publishedVersion = pluginManifest(published)?.version;
  if (!publishedVersion || publishedVersion !== pluginManifest(wanted)?.version) return null;
  const { added, changed, removed } = mirrorDifference(published, wanted);
  const pluginFiles = [...added, ...changed, ...removed].filter((file) => file.startsWith('plugins/'));
  if (pluginFiles.length === 0) return null;
  return `The plugin's files changed (${pluginFiles.join(', ')}) and its version is still ${publishedVersion}: raise "version" in ${PLUGIN_MANIFEST}.`;
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

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, confirm: false, ref: null };
  if (mode !== 'check' && mode !== 'push') return null;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--confirm' && mode === 'push') options.confirm = true;
    else if (rest[index] === '--ref' && rest[index + 1]) options.ref = rest[(index += 1)];
    else return null;
  }
  return options;
}

function refuse(message) {
  console.error(`Not published. ${message}`);
  process.exitCode = 1;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.error('usage: plugin-mirror.mjs check [--ref <ref>] | push [--ref <ref>] [--confirm]');
    process.exit(2);
  }
  const root = git(['rev-parse', '--show-toplevel'], path.dirname(fileURLToPath(import.meta.url))).trim();
  if (!options.ref) git(['fetch', '--quiet', 'origin', MIRROR_BRANCH], root);
  const ref = options.ref ?? DEFAULT_REF;
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`], root).trim();
  const wanted = mirrorFiles(root, commit);
  const repository = mirrorRepository(wanted);
  const version = pluginManifest(wanted).version;
  console.log(`${ref} (${commit.slice(0, 9)}) holds plugin ${version} for ${repository}.`);

  // A commit from before the marketplace moved names this repository: publishing it would
  // replace this repository's own main with the plugin's few files.
  if (repository === repositoryOfRemote(git(['remote', 'get-url', 'origin'], root))) {
    refuse(`${ref} names this repository itself as the public one.`);
    return;
  }
  const problems = findPrivateContent(wanted);
  if (problems.length > 0) {
    refuse(`The tree holds what must stay private:\n  ${problems.join('\n  ')}`);
    return;
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mirror-'));
  try {
    const published = clonePublished(repository, directory);
    const strays = [...published.keys()].filter((file) => !isMirrorPath(file));
    if (strays.length > 0) {
      refuse(`${repository} holds files that are no part of the marketplace (${strays.slice(0, 5).join(', ')}${strays.length > 5 ? ', …' : ''}): it is not the mirror, or someone added to it.`);
      return;
    }
    // Installs read the default branch, so that is the branch a push must land on.
    if (published.size > 0) {
      const branch = git(['symbolic-ref', '--short', 'HEAD'], directory).trim();
      if (branch !== MIRROR_BRANCH) {
        refuse(`${repository}'s default branch is ${branch}, not ${MIRROR_BRANCH}.`);
        return;
      }
    }

    const difference = mirrorDifference(published, wanted);
    if (difference.same) {
      console.log(`${repository} holds it as ${ref} has it.`);
      return;
    }
    console.log(`${repository} differs:`);
    printDifference(difference);
    if (options.mode === 'check') {
      process.exitCode = 1;
      return;
    }

    const stale = versionProblem(published, wanted);
    if (stale) {
      refuse(stale);
      return;
    }
    if (!options.confirm) {
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
    git([...COMMIT_CONFIGURATION, 'commit', '--quiet', '-m', `Magic Booklet plugin ${version}`], directory, { env: COMMIT_ENVIRONMENT });
    git(['push', '--quiet', 'origin', MIRROR_BRANCH], directory);
    console.log(`Published plugin ${version} to ${repository} at ${git(['rev-parse', 'HEAD'], directory).trim()}.`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Node runs the script from its real path, so the path it was called by is resolved the same way.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
