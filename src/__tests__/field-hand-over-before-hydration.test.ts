import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * What a visitor types into a field the server's HTML draws, before the page's script has run,
 * reaches no React: this React build hydrates a field without reading it back, so the page's
 * state keeps what the server drew and the field's next render writes it over the text. /login
 * and /admin/login signed in with an empty password, /contact sent an empty message, /search and
 * /templates dropped the query (2026-11-01 and 2026-11-05; the `*-typed-before-script.spec.ts`
 * specs in tests/e2e/).
 *
 * So a file that draws a controlled field (an input that takes typing, a textarea or a select,
 * given a `value`) hands what each field holds at mount to its page, through
 * `useFieldValueBeforeHydration` or, for text the page keeps, `useTypedBeforeHydration`, one call
 * per field. A file with fewer calls than fields is listed below with why: the rest are never in
 * the server's HTML (a dialog, a menu, a step a click opens, a component loaded with `ssr: false`
 * or drawn only once a session has loaded on the client). The check counts: it cannot tell which
 * field a call is for, so a file's calls and fields are compared, not paired.
 */

const projectRoot = process.cwd();
// Inputs that send the app's own value, never what was typed.
const UNTYPED_INPUTS = new Set(['hidden', 'radio', 'checkbox', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color']);
const HAND_OVER = /\buse(FieldValue|Typed)BeforeHydration\(/g;

// Each reason was checked on 2026-11-06, when the 36 files left unchecked on 2026-11-05 were gone
// through: the eleven that drew fields in the server's HTML now hand them over
// (the `*-before-script.spec.ts` specs in tests/e2e/; the admin console's, by a throwaway probe).
const NO_HAND_OVER: Record<string, string> = {
  'src/app/admin/(console)/content/PostModerationControls.tsx':
    'Its reason box opens on a click of Hide, Restore or Take down.',
  'src/app/admin/(console)/users/[userId]/GenerationModerationControls.tsx':
    'Its reason box opens on a click of Remove or Restore.',
  'src/app/auth/reset-password/page.tsx':
    'The new-password fields draw once the client has read the recovery session; the server draws the check’s spinner.',
  // Its prompt and Gemini Omni's two ID fields (one <input> in a map, two calls) are handed over.
  'src/app/create-video/CreateVideoClient.tsx':
    'A Kling subject’s name draws once the visitor adds a subject, and shot prompts once multi-shot is on, which no model opens on.',
  'src/app/create-workflow/WorkflowCanvasChrome.tsx':
    'The workflow canvas loads with `ssr: false` (CreateWorkflowEntry).',
  'src/app/create-workflow/WorkflowCanvasPanels.tsx':
    'The workflow canvas loads with `ssr: false` (CreateWorkflowEntry).',
  'src/app/create-workflow/WorkflowCanvasShareActions.tsx':
    'The workflow canvas loads with `ssr: false` (CreateWorkflowEntry); these fields sit in its share and import popovers.',
  'src/app/create-workflow/WorkflowLibraryClient.tsx':
    'The workflow library loads with `ssr: false` (CreateWorkflowEntry).',
  'src/app/create-workflow/WorkflowNodeEditors.tsx':
    'The workflow canvas’s inspector, loaded with `ssr: false` (CreateWorkflowEntry).',
  'src/app/create-workflow/WorkflowPlannerDrawer.tsx':
    'A drawer of the workflow canvas, loaded with `ssr: false` (CreateWorkflowEntry).',
  'src/app/create-workflow/WorkflowTemplatePublishDrawer.tsx':
    'A drawer of the workflow canvas, loaded with `ssr: false` (CreateWorkflowEntry).',
  'src/app/creations/CreatorProfileCard.tsx':
    'Its form is the Edit profile dialog, which a click opens after a profile read (ProfileActions); DeferredCreatorProfileCard loads it with `ssr: false`.',
  'src/app/delete-account/SignedInAccountDeletion.tsx':
    'Draws nothing until the client’s auth listener has a session.',
  'src/app/invite/InviteClient.tsx':
    'Its one field is read-only and draws once the client has read the referral summary.',
  'src/app/login/InviteCodeEntry.tsx':
    'Its field draws once “Have an invite code?” is clicked.',
  'src/app/marketplace/MarketplaceBrowser.tsx':
    'Loaded by MarketplaceBootstrap’s import() after a Load more click or a scroll.',
  'src/app/marketplace/MarketplaceToolFilter.tsx':
    'Its search draws only once enhanced on the client (useSyncExternalStore, false on the server).',
  'src/app/marketplace/sell/PayoutPanel.tsx':
    'Its request form draws after the client’s payouts read and a click.',
  'src/app/post/new/CreatableCombobox.tsx':
    'Drawn only in the composer’s Made with panel, which a click opens.',
  'src/app/post/new/ResourceCardEditorDialog.tsx':
    'A dialog that a recipe card’s click opens.',
  'src/app/showcase/ShowcaseClient.tsx':
    'Loaded by ShowcaseBootstrapClient’s import() in the browser.',
  'src/app/showcase/[id]/ReportPostButton.tsx': 'Its report form opens on a click.',
  'src/components/CatalogAdditionalControls.tsx':
    'Drawn in a creator’s settings sheet, which the settings chip opens, and in the `ssr: false` workflow inspector.',
  'src/components/CreatorColumn.tsx':
    'A reference tile’s name; every creator’s references start empty and fill on the client.',
  'src/components/CreatorPublish.tsx':
    'The publish panel draws once a run has finished on the client.',
  'src/components/PostComments.tsx':
    'The composer draws for a signed-in user, whom the post page’s server render never has; the report form opens on a click.',
  'src/components/StudioModelPicker.tsx':
    'Its search draws in the model list, which the model chip opens.',
  'src/components/templates/TemplateDetailClient.tsx':
    'Its report form opens on a click, after the client’s template read.',
};

function listTsxFiles(folder: string): string[] {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.tsx'))
    .map((entry) => join(folder, entry));
}

function attribute(element: ts.JsxOpeningLikeElement, name: string) {
  return element.attributes.properties
    .find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name);
}

/** A string attribute's value; any other value as its source text. */
function valueOf(attr: ts.JsxAttribute | undefined): string | null {
  const value = attr?.initializer;
  if (!value) return null;
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) return value.expression.text;
  return value.getText();
}

/** Every file of the app and its components that draws a controlled field: how many, and how many it hands over. */
function scan() {
  const files: { file: string; fields: number; handOvers: number }[] = [];
  for (const path of ['src/app', 'src/components'].flatMap((folder) => listTsxFiles(join(projectRoot, folder)))) {
    const source = readFileSync(path, 'utf8');
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let fields = 0;
    const visit = (node: ts.Node) => {
      const element = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
      const tag = element?.tagName.getText();
      if (element && attribute(element, 'value') && (tag === 'textarea' || tag === 'select'
        || (tag === 'input' && !UNTYPED_INPUTS.has(valueOf(attribute(element, 'type')) ?? 'text')))) {
        fields += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (fields > 0) files.push({ file: relative(projectRoot, path), fields, handOvers: source.match(HAND_OVER)?.length ?? 0 });
  }
  return files;
}

describe('files that draw a controlled field', () => {
  const files = scan();
  const short = files.filter((entry) => entry.handOvers < entry.fields);

  it('are found, the forms that hand their fields over among them', () => {
    expect(files.filter((entry) => entry.handOvers >= entry.fields).map((entry) => entry.file)).toEqual(expect.arrayContaining([
      'src/app/login/LoginClient.tsx',
      'src/app/admin/login/AdminLoginForm.tsx',
      'src/app/contact/ContactForm.tsx',
      'src/components/search/SearchField.tsx',
      'src/components/templates/TemplateCatalogClient.tsx',
      'src/app/create-image/CreateImageClient.tsx',
    ]));
  });

  it('hand each field’s early text over to the page, or say why they need not', () => {
    const missing = short.filter((entry) => !(entry.file in NO_HAND_OVER));

    expect(missing.map((entry) => `${entry.file}: ${entry.handOvers} of ${entry.fields} fields`)).toEqual([]);
  });

  it('leave the list once they hand every field over or draw none', () => {
    const shortFiles = new Set(short.map((entry) => entry.file));

    expect(Object.keys(NO_HAND_OVER).filter((file) => !shortFiles.has(file))).toEqual([]);
  });
});
