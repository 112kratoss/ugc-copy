import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Until a page's script has run, Enter in a field submits the form the browser's own way, and
 * a form with no method submits as a GET, which writes every named field into the address:
 * /login put the password in the address bar, the history and any log that keeps query strings
 * (2026-11-01; tests/e2e/form-submit-before-script.spec.ts shows it on /login and /contact).
 * So every form with a named field states its method: post, or get when each of its fields
 * belongs in an address. A form the browser alone draws today is held to it too, since its page
 * can start drawing it on the server.
 */

const projectRoot = process.cwd();
const FIELD_TAGS = new Set(['input', 'select', 'textarea']);
// What a GET form may write into the address: a search's query.
const ADDRESS_FIELDS = new Set(['q']);

type NamedForm = { at: string; method: string | null; fields: string[] };

function listTsxFiles(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.tsx'))
    .map((entry) => join(folder, entry));
}

function attribute(element: ts.JsxOpeningLikeElement, name: string) {
  return element.attributes.properties
    .find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name);
}

/** A string attribute's value; any other value as its source text, which no rule here accepts. */
function valueOf(attr: ts.JsxAttribute | undefined): string | null {
  const value = attr?.initializer;
  if (!value) return null;
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) return value.expression.text;
  return value.getText();
}

function findNamedForms(): NamedForm[] {
  const forms: NamedForm[] = [];
  for (const file of ['src/app', 'src/components'].flatMap((folder) => listTsxFiles(join(projectRoot, folder)))) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('<form')) continue;

    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'form') {
        const fields: string[] = [];
        const collect = (child: ts.Node) => {
          const element = ts.isJsxElement(child) ? child.openingElement : ts.isJsxSelfClosingElement(child) ? child : null;
          const name = element && FIELD_TAGS.has(element.tagName.getText()) ? valueOf(attribute(element, 'name')) : null;
          if (name !== null) fields.push(name);
          ts.forEachChild(child, collect);
        };
        ts.forEachChild(node, collect);
        if (fields.length > 0) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          forms.push({ at: `${relative(projectRoot, file)}:${line + 1}`, method: valueOf(attribute(node.openingElement, 'method')), fields });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return forms;
}

describe('forms with named fields', () => {
  const forms = findNamedForms();

  it('are found, the three drawn in the server\'s HTML among them', () => {
    expect(forms.map((form) => form.at.replace(/:\d+$/, ''))).toEqual(expect.arrayContaining([
      'src/app/login/LoginClient.tsx',
      'src/app/admin/login/AdminLoginForm.tsx',
      'src/app/contact/ContactForm.tsx',
    ]));
  });

  it('state their method: post, or get when every field belongs in an address', () => {
    const unsafe = forms.filter((form) => !(form.method === 'post'
      || (form.method === 'get' && form.fields.every((field) => ADDRESS_FIELDS.has(field)))));

    expect(unsafe).toEqual([]);
  });
});
