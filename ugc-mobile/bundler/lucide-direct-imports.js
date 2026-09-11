// Babel plugin: rewrites `import { Camera, X as Close } from 'lucide-react-native'`
// into one import per module inside the package,
//
//   import Camera from 'lucide-react-native/dist/esm/icons/camera.mjs';
//   import Close from 'lucide-react-native/dist/esm/icons/x.mjs';
//
// because the package root is a barrel over every icon (~1,700), and Metro
// keeps — and at launch evaluates — every module a bundle imports. One root
// import therefore shipped all of them although the app draws 94: measured on
// the Android export of 2026-09-12, the unused icons plus the barrel were ~17%
// of the bundle.
//
// The name -> module table is read from the barrel itself, so aliases resolve
// exactly as the package defines them (`Home` lives in house.mjs; kebab-casing
// the name would guess wrong). A name the barrel does not export fails the build
// rather than quietly falling back to the barrel. metro.config.js resolves the
// deep paths, which the package's "exports" map does not list.
//
// Vitest does not run Babel, so tests keep importing — and mocking — the package
// root. Metro's transform cache does not track this file: after editing it, run
// `expo start --clear`.

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE = 'lucide-react-native';
const BARREL_EXPORT = /export \{([^}]*)\} from '\.\/([^']+)';/g;

let exportTable = null;

function readExportTable() {
  if (exportTable) return exportTable;

  // "exports" hides package.json and dist/esm, but "." resolves to the CommonJS
  // build at dist/cjs, and the ESM barrel sits beside it.
  const packageRoot = path.resolve(path.dirname(require.resolve(PACKAGE)), '..', '..');
  const barrelPath = path.join(packageRoot, 'dist', 'esm', 'lucide-react-native.mjs');
  const table = new Map();
  for (const [, names, file] of fs.readFileSync(barrelPath, 'utf8').matchAll(BARREL_EXPORT)) {
    for (const entry of names.split(',')) {
      const [imported, exported = imported] = entry.trim().split(/\s+as\s+/);
      if (imported) table.set(exported.trim(), { file, imported: imported.trim() });
    }
  }

  if (table.size < 1000) {
    throw new Error(
      `lucide-direct-imports read only ${table.size} exports from ${barrelPath}; `
      + 'the barrel format changed, so this plugin needs updating.',
    );
  }
  exportTable = table;
  return table;
}

module.exports = function lucideDirectImports({ types: t }) {
  return {
    name: 'lucide-direct-imports',
    visitor: {
      ImportDeclaration(declaration) {
        const { node } = declaration;
        if (node.source.value !== PACKAGE || node.importKind === 'type') return;

        if (node.specifiers.length === 0) {
          throw declaration.buildCodeFrameError(`A bare import of ${PACKAGE} evaluates every icon.`);
        }

        const table = readExportTable();
        const direct = [];
        for (const specifier of node.specifiers) {
          if (!t.isImportSpecifier(specifier)) {
            throw declaration.buildCodeFrameError(
              `Import icons from ${PACKAGE} by name: a default or namespace import needs the whole barrel.`,
            );
          }
          // Types have no runtime import to rewrite, so they are dropped here as
          // the TypeScript transform would drop them. Keeping them in a new
          // declaration risks it outliving that transform and becoming a
          // require() of the barrel.
          if (specifier.importKind === 'type') continue;

          const name = t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value;
          const entry = table.get(name);
          if (!entry) {
            throw declaration.buildCodeFrameError(
              `${PACKAGE} has no runtime export named "${name}". Import types with \`import type\`.`,
            );
          }

          const local = t.identifier(specifier.local.name);
          direct.push(t.importDeclaration(
            [entry.imported === 'default'
              ? t.importDefaultSpecifier(local)
              : t.importSpecifier(local, t.identifier(entry.imported))],
            t.stringLiteral(`${PACKAGE}/dist/esm/${entry.file}`),
          ));
        }

        if (direct.length === 0) declaration.remove();
        else declaration.replaceWithMultiple(direct);
      },
    },
  };
};
