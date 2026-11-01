import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Until a page's script has run, Enter in a field submits its form the browser's own way, and a
 * form with no method submits as a GET, which writes every named field into the address: /login
 * put the password in the address bar, the history and any log that keeps query strings
 * (2026-11-01; tests/e2e/form-submit-before-script.spec.ts shows it on /login and /contact).
 *
 * A form's script reads what was typed from its own state, so a typed field needs no name, and a
 * field without one is never sent. A typed field carries a name only where such a submission
 * cannot put it in an address:
 * - it belongs in one: a search's `q`;
 * - its form posts to a page rendered on every request. A post is no way out on a prerendered
 *   page: Vercel answers it itself, with an empty 405 (/contact, 2026-11-01);
 * - its form is drawn only by the browser, once the script has run.
 * Every file is scanned, not only the `<form>` written in it, since a component's fields end up
 * in whichever form draws them.
 */

const projectRoot = process.cwd();
// Inputs that send the app's own value, as a select does, never what was typed.
const UNTYPED_INPUTS = new Set(['hidden', 'radio', 'checkbox', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color']);
// What may be written into an address: a search's query.
const ADDRESS_FIELDS = new Set(['q']);
// The forms that post, each with the page that draws it.
const POSTING_FORMS: Record<string, string> = {
  'src/app/login/LoginClient.tsx': 'src/app/login/page.tsx',
  'src/app/admin/login/AdminLoginForm.tsx': 'src/app/admin/login/page.tsx',
};
// The profile editor is loaded with `ssr: false` (DeferredCreatorProfileCard) or opened by its
// owner (ProfileActions), and finds its first invalid field by name.
const DRAWN_BY_THE_BROWSER = new Set(['src/app/creations/CreatorProfileCard.tsx']);

type NamedField = { at: string; file: string; name: string; inPostingForm: boolean };
type Form = { at: string; file: string; method: string | null };

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

function scan() {
  const fields: NamedField[] = [];
  const forms: Form[] = [];
  for (const path of ['src/app', 'src/components'].flatMap((folder) => listTsxFiles(join(projectRoot, folder)))) {
    const file = relative(projectRoot, path);
    const sourceFile = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const at = (node: ts.Node) => `${file}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;

    // `method` is the method of the <form> around the node, null for none, undefined outside one.
    const visit = (node: ts.Node, method: string | null | undefined) => {
      let formMethod = method;
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'form') {
        formMethod = valueOf(attribute(node.openingElement, 'method'));
        forms.push({ at: at(node), file, method: formMethod });
      }
      const element = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
      const tag = element?.tagName.getText();
      if (element && (tag === 'textarea' || (tag === 'input' && !UNTYPED_INPUTS.has(valueOf(attribute(element, 'type')) ?? 'text')))) {
        const name = valueOf(attribute(element, 'name'));
        if (name !== null) fields.push({ at: at(element), file, name, inPostingForm: formMethod === 'post' });
      }
      ts.forEachChild(node, (child) => visit(child, formMethod));
    };
    visit(sourceFile, undefined);
  }
  return { fields, forms };
}

describe('typed fields with a name', () => {
  const { fields, forms } = scan();

  it('are found wherever they are drawn, outside the <form> written in their file too', () => {
    expect(fields.map((field) => `${field.file} ${field.name}`)).toEqual(expect.arrayContaining([
      'src/app/login/LoginClient.tsx password',
      'src/app/admin/login/AdminLoginForm.tsx password',
      'src/app/marketplace/MarketplaceBootstrap.tsx q',
      // Drawn by one of the file's components, outside the <form> it ends up in.
      'src/app/creations/CreatorProfileCard.tsx bio',
    ]));
  });

  it('carry a name only where a submission before the script cannot put it in an address', () => {
    const unsafe = fields.filter((field) => !(ADDRESS_FIELDS.has(field.name)
      || DRAWN_BY_THE_BROWSER.has(field.file)
      || (field.inPostingForm && field.file in POSTING_FORMS)));

    expect(unsafe.map((field) => `${field.at} ${field.name}`)).toEqual([]);
  });

  it('post only to a page rendered on every request', () => {
    expect(forms.filter((form) => form.method === 'post').map((form) => form.file).sort())
      .toEqual(Object.keys(POSTING_FORMS).sort());
    for (const [form, page] of Object.entries(POSTING_FORMS)) {
      const source = readFileSync(join(projectRoot, page), 'utf8');
      expect(source, `${page} draws ${form}`).toContain(basename(form, '.tsx'));
      expect(source, `${page} renders on every request`).toMatch(/^export const dynamic = 'force-dynamic';$/m);
    }
  });
});
