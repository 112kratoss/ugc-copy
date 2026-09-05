/** Read-only source inventory. Print JSON; no credentials or network required. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const files: string[] = [];
function walk(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['__tests__', 'node_modules', '.next'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.[jt]sx?$/.test(file)) files.push(file);
  }
}
for (const dir of ['src', 'ugc-mobile/app', 'ugc-mobile/components', 'ugc-mobile/lib']) walk(dir);
const fileSet = new Set(files);
const reverse = new Map<string, Set<string>>();
const renderers: Array<{ file: string; line: number; renderer: string; source: string; props: string[] }> = [];
const shared = new Set(['StableMediaImage', 'OptimizedPreviewImage', 'HoverVideo', 'MediaPreview',
  'FeedMediaFrame', 'ShowcaseMediaPreview', 'FeedVideoPreview', 'MediaLightbox']);
const playerHooks = new Set(['useVideoPlayer', 'createVideoPlayer', 'useAudioPlayer']);

function resolveImport(file: string, specifier: string) {
  const base = specifier.startsWith('@/')
    ? path.join(file.startsWith('ugc-mobile/') ? 'ugc-mobile' : 'src', specifier.slice(2))
    : specifier.startsWith('.') ? path.join(path.dirname(file), specifier) : null;
  if (!base) return null;
  return [base, ...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'].map((ext) => base + ext)]
    .find((candidate) => fileSet.has(candidate)) ?? null;
}

for (const file of files.sort()) {
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'),
    ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const resolved = resolveImport(file, specifier);
      if (resolved) {
        const parents = reverse.get(resolved) ?? new Set<string>();
        parents.add(file);
        reverse.set(resolved, parents);
      }
      const clause = node.importClause;
      if (clause?.name) imports.set(clause.name.text, specifier);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const binding of clause.namedBindings.elements) imports.set(binding.name.text, specifier);
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(sourceFile);
      const imported = imports.get(name) ?? '';
      const primitive = ['img', 'video', 'audio'].includes(name)
        || ['next/image', 'expo-image', 'expo-video'].includes(imported)
        || (imported === 'react-native' && name === 'Image');
      if (primitive || shared.has(name)) {
        renderers.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          renderer: name, source: imported || 'HTML',
          props: node.attributes.properties.map((prop) => ts.isJsxAttribute(prop) ? prop.name.getText(sourceFile) : '...spread') });
      }
    }
    if (ts.isCallExpression(node) && playerHooks.has(node.expression.getText(sourceFile))) {
      const name = node.expression.getText(sourceFile);
      renderers.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        renderer: name, source: imports.get(name) ?? 'local', props: [] });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function routesFor(file: string) {
  const routes = new Set<string>();
  const seen = new Set<string>();
  function visit(current: string) {
    if (seen.has(current)) return;
    seen.add(current);
    if ((current.startsWith('src/app/') && /\/(page|layout)\.tsx$/.test(current))
      || (current.startsWith('ugc-mobile/app/') && current.endsWith('.tsx'))) routes.add(current);
    for (const parent of reverse.get(current) ?? []) visit(parent);
  }
  visit(file);
  return [...routes].sort();
}
console.log(JSON.stringify({
  scannedFiles: files.length,
  callSites: renderers.length,
  mediaFiles: new Set(renderers.map((row) => row.file)).size,
  caveat: 'Static JSX/player-call and import graph, not runtime coverage. Dynamic imports, prop-selected renderers, CSS backgrounds, and prefetch need manual review.',
  renderers: renderers.map((row) => ({ ...row,
    directImporters: [...reverse.get(row.file) ?? []].sort(),
    routeCandidates: routesFor(row.file),
  })),
}, null, 2));
