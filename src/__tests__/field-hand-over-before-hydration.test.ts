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

// Files that drew more controlled fields than they hand over when this check was written, not yet
// looked at. Each one leaves this list for hook calls or a reason of its own; none joins it.
const NOT_YET_CHECKED = 'not yet checked (2026-11-05)';

const NO_HAND_OVER: Record<string, string> = {
  'src/app/admin/(console)/content/PostModerationControls.tsx': NOT_YET_CHECKED,
  'src/app/admin/(console)/moderation/ModerationActions.tsx': NOT_YET_CHECKED,
  'src/app/admin/(console)/payouts/PayoutActions.tsx': NOT_YET_CHECKED,
  'src/app/admin/(console)/system/ContactTriageControls.tsx': NOT_YET_CHECKED,
  'src/app/admin/(console)/users/[userId]/CreditAdjustmentForm.tsx': NOT_YET_CHECKED,
  'src/app/admin/(console)/users/[userId]/GenerationModerationControls.tsx': NOT_YET_CHECKED,
  'src/app/admin/(console)/users/[userId]/UserSanctionForm.tsx': NOT_YET_CHECKED,
  'src/app/auth/reset-password/page.tsx': NOT_YET_CHECKED,
  // Its prompt is handed over; its other three fields are not yet checked.
  'src/app/create-video/CreateVideoClient.tsx': NOT_YET_CHECKED,
  'src/app/create-workflow/WorkflowCanvasChrome.tsx': NOT_YET_CHECKED,
  'src/app/create-workflow/WorkflowCanvasPanels.tsx': NOT_YET_CHECKED,
  'src/app/create-workflow/WorkflowCanvasShareActions.tsx': NOT_YET_CHECKED,
  'src/app/create-workflow/WorkflowLibraryClient.tsx': NOT_YET_CHECKED,
  'src/app/create-workflow/WorkflowNodeEditors.tsx': NOT_YET_CHECKED,
  'src/app/create-workflow/WorkflowPlannerDrawer.tsx': NOT_YET_CHECKED,
  'src/app/create-workflow/WorkflowTemplatePublishDrawer.tsx': NOT_YET_CHECKED,
  'src/app/creations/CreatorProfileCard.tsx': NOT_YET_CHECKED,
  'src/app/delete-account/SignedInAccountDeletion.tsx': NOT_YET_CHECKED,
  'src/app/invite/InviteClient.tsx': NOT_YET_CHECKED,
  'src/app/marketplace/MarketplaceBrowser.tsx': NOT_YET_CHECKED,
  'src/app/marketplace/MarketplaceToolFilter.tsx': NOT_YET_CHECKED,
  'src/app/marketplace/sell/PayoutPanel.tsx': NOT_YET_CHECKED,
  'src/app/marketplace/sell/SellerRecipeList.tsx': NOT_YET_CHECKED,
  'src/app/post/new/CreatableCombobox.tsx': NOT_YET_CHECKED,
  'src/app/post/new/NewPostClient.tsx': NOT_YET_CHECKED,
  'src/app/post/new/ResourceCardEditorDialog.tsx': NOT_YET_CHECKED,
  'src/app/post/new/ResourceCardsSection.tsx': NOT_YET_CHECKED,
  'src/app/pricing/PricingClient.tsx': NOT_YET_CHECKED,
  'src/app/showcase/ShowcaseClient.tsx': NOT_YET_CHECKED,
  'src/app/showcase/[id]/ReportPostButton.tsx': NOT_YET_CHECKED,
  'src/components/CatalogAdditionalControls.tsx': NOT_YET_CHECKED,
  'src/components/CreatorColumn.tsx': NOT_YET_CHECKED,
  'src/components/CreatorPublish.tsx': NOT_YET_CHECKED,
  'src/components/PostComments.tsx': NOT_YET_CHECKED,
  'src/components/PublicIdentityFields.tsx': NOT_YET_CHECKED,
  'src/components/StudioModelPicker.tsx': NOT_YET_CHECKED,
  'src/components/templates/TemplateDetailClient.tsx': NOT_YET_CHECKED,
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
