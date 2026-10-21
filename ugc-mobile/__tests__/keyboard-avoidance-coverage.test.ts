import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { canBeAbsent, SCROLLER } from './fixtures/jsx-syntax';

const mobileRoot = path.resolve(__dirname, '..');
const sourceRoots = ['app', 'components'] as const;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...sourceFiles(absolutePath));
    } else if (/\.tsx$/.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function relativePath(filePath: string) {
  return path.relative(mobileRoot, filePath).replaceAll(path.sep, '/');
}

const screenFiles = sourceRoots.flatMap((root) => sourceFiles(path.join(mobileRoot, root)));

/**
 * Files whose fields legitimately reach no avoidance inside the file, because
 * every screen that draws them provides it.
 */
const PROVIDED_BY_ANCESTOR = new Set([
  // The shared primitive itself; screens opt in via `<Screen keyboardAware>`.
  'components/ui.tsx',
]);

const FIELD = /(?:^|\.)(?:TextInput|AppTextInput|ProfileTextField|ComposerInput|WorkspaceInput)$/;
/** Surfaces drawn somewhere else (the overlay host, a Modal's window): an area around one does not reach inside. */
const ELSEWHERE = new Set(['Overlay', 'Modal']);

type Walk = {
  /** Whether the field sits in a scroll view: only one can make the room on iOS. */
  scrolls: boolean;
  /** Whether one of the scroll views passed carries `automaticallyAdjustKeyboardInsets`. */
  adjustsInsets: boolean;
  /** Set once the field has met its area: the walk goes on up to check no scroll view holds the area. */
  area: number | null;
  trail: string[];
  /**
   * Declarations and components already followed on this way up, so one that draws itself is not
   * followed forever. Kept by node, not name: another `body` in another component is a new way up.
   */
  followed: ReadonlySet<ts.Node>;
};

/**
 * Every text field in one file, and each way it can be drawn with nothing
 * giving way to the keyboard, as `file:line <Tag>: why (path)`.
 *
 * A field is followed up through what draws it: the elements around it, a
 * variable or function that holds it to every place that uses that name, and
 * an in-file component up to each `<Component>` that draws it, until something
 * gives way (`KeyboardAvoidingArea`, `KeyboardLift`, `<Screen keyboardAware>`)
 * or nothing is left above. Every way up has to meet one: a sheet's area makes
 * no room for the page under it, which is how the post composer's own Title,
 * Story and package fields sat under the keyboard while the file passed on the
 * resource sheet's area (Pixel 9a emulator, 2026-10-21 and 22). What is passed
 * to an in-file component, as children or as another prop, is followed from
 * where that component reads it; one it cannot be followed into is taken as
 * drawn where the element is, unless the component draws an `Overlay` or a
 * `Modal`. An area outside an `Overlay` or a `Modal` does not reach the surface
 * inside it, which is drawn elsewhere. And an area that leaves iOS to
 * `automaticallyAdjustKeyboardInsets` has to be met through a scroll view that
 * carries it, or iOS gets nothing; a field outside any scroll view (the model
 * picker's search field, above its list) needs one in the area all the same.
 * The area itself must not sit inside a vertical scroll view: there it pads the
 * scroll view's content and the view keeps its height, so Android never brings
 * the field up. `keyboardAware` and `automaticallyAdjustKeyboardInsets` count
 * only when written so that they cannot come out off.
 */
function sweep(name: string, source: string) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const tagOf = (element: ts.JsxElement | ts.JsxSelfClosingElement) =>
    (ts.isJsxElement(element) ? element.openingElement : element).tagName.getText(file);
  const attributesOf = (element: ts.JsxElement | ts.JsxSelfClosingElement) =>
    (ts.isJsxElement(element) ? element.openingElement : element).attributes;
  /** Present, and not written `={false}`: the reading that makes a check stricter. */
  const flagged = (element: ts.JsxElement | ts.JsxSelfClosingElement, wanted: string) =>
    attributesOf(element).properties.some((property) => ts.isJsxAttribute(property)
      && property.name.getText(file) === wanted
      && !(property.initializer
        && ts.isJsxExpression(property.initializer)
        && property.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword));
  /**
   * On in every state: written bare, or as an expression that cannot come out `undefined`, `null` or
   * `false` by its own syntax, and not taken back by a spread written after it (in JSX the later one
   * wins). The reading for a prop the check relies on.
   */
  const on = (element: ts.JsxElement | ts.JsxSelfClosingElement, wanted: string) => {
    const properties = attributesOf(element).properties;
    const index = properties.findIndex((property) => ts.isJsxAttribute(property) && property.name.getText(file) === wanted);
    if (index < 0 || properties.slice(index + 1).some(ts.isJsxSpreadAttribute)) return false;
    const value = (properties[index] as ts.JsxAttribute).initializer;
    if (!value) return true;
    return ts.isJsxExpression(value) && value.expression !== undefined && !canBeAbsent(value.expression);
  };
  /** `<Screen>` draws a scroll view unless it is told `scroll={false}`, and only then reads `keyboardAware`. */
  const screenScrolls = (element: ts.JsxElement | ts.JsxSelfClosingElement) => !attributesOf(element).properties.some((property) =>
    ts.isJsxAttribute(property)
    && property.name.getText(file) === 'scroll'
    && property.initializer !== undefined
    && ts.isJsxExpression(property.initializer)
    && property.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword);

  const fields: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];
  const functions = new Map<string, ts.FunctionLikeDeclaration>();
  const collect = (node: ts.Node) => {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && FIELD.test(tagOf(node))) fields.push(node);
    const bound = boundName(node);
    if (bound && ts.isFunctionLike(node)) functions.set(bound, node as ts.FunctionLikeDeclaration);
    ts.forEachChild(node, collect);
  };

  /** The name a function or a value is held under, when the walk can follow it to its uses. */
  function boundName(node: ts.Node): string | null {
    if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
    if (ts.isVariableDeclaration(node)) return ts.isIdentifier(node.name) ? node.name.text : null;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // `const Row = memo(() => …)`, `const render = useCallback(() => …)`: the call hands it to the name.
      let holder: ts.Node = node.parent;
      while (ts.isCallExpression(holder) || ts.isParenthesizedExpression(holder) || ts.isAsExpression(holder)) {
        holder = holder.parent;
      }
      return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text : null;
    }
    return null;
  }

  /** Where a name declared at `declaration` is used: tags and values, within the block that declares it. */
  function usesOf(nameText: string, declaration: ts.Node): ts.Node[] {
    let scope: ts.Node = declaration.parent;
    while (!ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) scope = scope.parent;
    const uses: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (node === declaration) return;
      if (ts.isIdentifier(node) && node.text === nameText) {
        const parent = node.parent;
        const isName = (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)
          || ts.isJsxAttribute(parent) || ts.isBindingElement(parent) || ts.isParameter(parent)
          || ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name === node;
        if (!isName && !ts.isJsxClosingElement(parent)) uses.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return uses;
  }

  /** Where an in-file component reads a prop it is given (`children` for what is nested in it). */
  function propSlots(component: ts.FunctionLikeDeclaration, prop: string): ts.Node[] {
    const slots: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === prop) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
          slots.push(parent); // `props.children`
        } else if (!((ts.isBindingElement(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent)
          || ts.isPropertyAssignment(parent) || ts.isJsxAttribute(parent)) && parent.name === node)) {
          slots.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    if (component.body) visit(component.body);
    return slots;
  }

  /** Whether some element under `root` matches. */
  function drawsAny(root: ts.Node, matches: (element: ts.JsxElement | ts.JsxSelfClosingElement) => boolean): boolean {
    let found = false;
    const visit = (node: ts.Node) => {
      if (found) return;
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && matches(node)) found = true;
      else ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
    return found;
  }

  type Outcome = { failures: string[]; resumes: Walk[] };

  /**
   * Follows `start` upward. Without `boundary` every way up ends in a decision; with one (a component's
   * own function, entered at its `children`), a way that reaches it comes back as a walk to resume
   * from the element that drew the component.
   */
  function follow(start: ts.Node, walk: Walk, boundary?: ts.Node): Outcome {
    let current = walk;
    const fail = (why: string): Outcome => ({
      failures: [current.trail.length > 0 ? `${why} (through ${current.trail.join(' < ')})` : why],
      resumes: [],
    });
    let previous: ts.Node = start;
    let node: ts.Node | undefined = start.parent;
    // The prop the walk came up through, read when it reaches the element that takes it.
    let attribute: string | null = null;
    while (node && node !== boundary) {
      if (ts.isJsxAttribute(node)) attribute = node.name.getText(file);
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = tagOf(node);
        if (current.area !== null) {
          // Above the field's area: only a scroll view holding it matters, up to a surface drawn elsewhere.
          if (ELSEWHERE.has(tag)) return { failures: [], resumes: [] };
          if ((SCROLLER.test(tag) && !flagged(node, 'horizontal')) || (tag === 'Screen' && screenScrolls(node))) {
            return fail(`the KeyboardAvoidingArea at line ${current.area} is inside the ${tag} at line ${lineOf(node)}: it pads that scroll view's content instead of shortening it`);
          }
        } else if (tag === 'KeyboardAvoidingArea') {
          if (flagged(node, 'iosScrollViewAdjustsInsets') && !(current.scrolls
            ? current.adjustsInsets
            : drawsAny(node, (inner) => SCROLLER.test(tagOf(inner)) && on(inner, 'automaticallyAdjustKeyboardInsets')))) {
            return fail(`the KeyboardAvoidingArea at line ${lineOf(node)} leaves iOS to a scroll view's automaticallyAdjustKeyboardInsets, and ${current.scrolls ? 'the field\'s scroll view does not carry it' : 'no scroll view in it carries it'}`);
          }
          // Met: what is left to check is what holds the area.
          return follow(node, { ...current, area: lineOf(node), trail: [...current.trail, `area at line ${lineOf(node)}`], followed: new Set() }, boundary);
        } else {
          if (tag === 'KeyboardLift' || (tag === 'Screen' && screenScrolls(node) && on(node, 'keyboardAware'))) return { failures: [], resumes: [] };
          if (ELSEWHERE.has(tag)) return fail(`drawn in the ${tag} at line ${lineOf(node)} with nothing inside it giving way`);
          if (SCROLLER.test(tag)) {
            current = { ...current, scrolls: true, adjustsInsets: current.adjustsInsets || on(node, 'automaticallyAdjustKeyboardInsets') };
          }
        }
        const component = functions.get(tag);
        const prop = ts.isJsxElement(node) && node.children.includes(previous as ts.JsxChild)
          ? 'children'
          : previous === (ts.isJsxElement(node) ? node.openingElement : node.attributes) ? attribute : null;
        if (component && prop && !current.followed.has(component)) {
          const slots = propSlots(component, prop);
          if (slots.length === 0) {
            if (drawsAny(component, (inner) => ELSEWHERE.has(tagOf(inner)))) {
              return fail(`given to the ${tag} at line ${lineOf(node)} as \`${prop}\`, which it may draw in its Overlay or Modal where the sweep cannot follow`);
            }
          } else {
            // The prop is drawn where the component reads it.
            const inside = { ...current, trail: [...current.trail, `${tag} ${prop}`], followed: new Set([...current.followed, component]) };
            const outcomes = slots.map((slot) => follow(slot, inside, component));
            const failures = outcomes.flatMap((outcome) => outcome.failures);
            const resumed = outcomes.flatMap((outcome) => outcome.resumes)
              .map((resume) => follow(node as ts.Node, { ...resume, trail: current.trail, followed: current.followed }, boundary));
            return {
              failures: [...failures, ...resumed.flatMap((outcome) => outcome.failures)],
              resumes: resumed.flatMap((outcome) => outcome.resumes),
            };
          }
        }
        attribute = null;
      }
      const bound = boundName(node);
      if (bound && (ts.isFunctionLike(node) || ts.isVariableDeclaration(node))) {
        const declaration = ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)
          ? node
          : (() => {
            let holder: ts.Node = node.parent;
            while (!ts.isVariableDeclaration(holder)) holder = holder.parent;
            return holder;
          })();
        if (current.followed.has(declaration)) return { failures: [], resumes: [] };
        const uses = usesOf(bound, declaration);
        if (uses.length === 0) {
          return current.area !== null ? { failures: [], resumes: [] } : fail(`nothing gives way on the way up to ${bound}`);
        }
        const next = { ...current, followed: new Set([...current.followed, declaration]) };
        const outcomes = uses.map((use) => follow(use, { ...next, trail: [...current.trail, `${bound} at line ${lineOf(use)}`] }, boundary));
        return {
          failures: outcomes.flatMap((outcome) => outcome.failures),
          resumes: outcomes.flatMap((outcome) => outcome.resumes),
        };
      }
      previous = node;
      node = node.parent;
    }
    if (node === boundary && boundary) return { failures: [], resumes: [current] };
    return current.area !== null ? { failures: [], resumes: [] } : fail('nothing gives way on the way up to the file');
  }

  collect(file);
  return fields.map((field) => ({
    field: `${name}:${lineOf(field)} <${tagOf(field)}>`,
    failures: follow(field, { scrolls: false, adjustsInsets: false, area: null, trail: [], followed: new Set() }).failures,
  }));
}

const tree = screenFiles.map((filePath) => ({
  name: relativePath(filePath),
  fields: sweep(relativePath(filePath), readFileSync(filePath, 'utf8')),
}));

/** The fields of a source with at least one way up that meets nothing, as `line <Tag>`. */
function uncovered(source: string) {
  return sweep('case.tsx', source)
    .filter(({ failures }) => failures.length > 0)
    .map(({ field }) => field.replace('case.tsx:', ''));
}

/**
 * Android 15 forces edge-to-edge, which stopped the window resizing for the
 * keyboard, and iOS never resized it at all. A screen that takes text input and
 * does nothing about the keyboard will cover its own focused field — the field
 * still accepts typing, so this fails silently and only shows up on a device.
 */
describe('keyboard avoidance coverage', () => {
  it('follows each field up to what makes room for it', () => {
    // The post composer as it was on 2026-10-21: its page draws the fields from
    // components and a variable inside a plain ScrollView, and the only area in
    // the file is the hosted resource sheet's. The file held the marker, so a
    // check per file passed it.
    const composerShape = `
      function ComposerInput() { return <TextInput />; }
      function DetailsPage() {
        const titleField = (<View><ComposerInput /></View>);
        return <View>{titleField}<ComposerInput multiline /></View>;
      }
      function ResourceSheet() {
        return (
          <Overlay visible={presentation.rendered}>
            <KeyboardAvoidingArea iosScrollViewAdjustsInsets followsKeyboard={presentation.settled}>
              <ScrollView automaticallyAdjustKeyboardInsets><ComposerInput /></ScrollView>
            </KeyboardAvoidingArea>
          </Overlay>
        );
      }
      export default function Composer() {
        return (
          <View>
            <ScrollView keyboardShouldPersistTaps="handled"><DetailsPage /></ScrollView>
            <Footer />
            <ResourceSheet />
          </View>
        );
      }`;
    expect(uncovered(composerShape)).toEqual(['2 <TextInput>', '4 <ComposerInput>', '5 <ComposerInput>']);

    // The same page with its own area: every way up meets one.
    expect(uncovered(composerShape.replace(
      '<ScrollView keyboardShouldPersistTaps="handled"><DetailsPage /></ScrollView>\n            <Footer />',
      '<KeyboardAvoidingArea iosScrollViewAdjustsInsets><ScrollView automaticallyAdjustKeyboardInsets><DetailsPage /></ScrollView><Footer /></KeyboardAvoidingArea>',
    ))).toEqual([]);
  });

  it('sees what does not reach a field', () => {
    const unreached = [
      // Nothing at all.
      'function Page() { return <ScrollView><TextInput /></ScrollView>; }',
      // An area beside the field rather than around it.
      'function Page() { return <View><KeyboardAvoidingArea><Header /></KeyboardAvoidingArea><TextInput /></View>; }',
      // An area outside a surface drawn elsewhere.
      'function Page() { return <KeyboardAvoidingArea><Modal visible><TextInput /></Modal></KeyboardAvoidingArea>; }',
      'function Page() { return <KeyboardAvoidingArea><Overlay visible={p.rendered}><TextInput /></Overlay></KeyboardAvoidingArea>; }',
      // iOS left to a scroll view that does not adjust its insets.
      'function Page() { return <KeyboardAvoidingArea iosScrollViewAdjustsInsets><ScrollView><TextInput /></ScrollView></KeyboardAvoidingArea>; }',
      'function Page() { return <KeyboardAvoidingArea iosScrollViewAdjustsInsets><FlatList renderItem={() => <TextInput />} /></KeyboardAvoidingArea>; }',
      // A Screen that does not opt in, may not, or draws no scroll view to give way with.
      'function Page() { return <Screen><AppTextInput /></Screen>; }',
      'function Page() { return <Screen keyboardAware={false}><AppTextInput /></Screen>; }',
      'function Page() { return <Screen keyboardAware={editing ? true : undefined}><AppTextInput /></Screen>; }',
      'function Page() { return <Screen keyboardAware scroll={false}><AppTextInput /></Screen>; }',
      // The native prop iOS is left to, written so that it can come out off.
      'function Page() { return <KeyboardAvoidingArea iosScrollViewAdjustsInsets><ScrollView automaticallyAdjustKeyboardInsets={open ? undefined : true}><TextInput /></ScrollView></KeyboardAvoidingArea>; }',
      'function Page() { return <KeyboardAvoidingArea iosScrollViewAdjustsInsets><ScrollView automaticallyAdjustKeyboardInsets {...rest}><TextInput /></ScrollView></KeyboardAvoidingArea>; }',
      // An area inside the scroll view it should shorten pads the content instead.
      'function Page() { return <ScrollView><KeyboardAvoidingArea><TextInput /></KeyboardAvoidingArea></ScrollView>; }',
      'function Form() { return <KeyboardAvoidingArea><TextInput /></KeyboardAvoidingArea>; }\nfunction Page() { return <ScrollView><Form /></ScrollView>; }',
      // iOS left to a scroll view the area does not hold.
      'function Page() { return <KeyboardAvoidingArea iosScrollViewAdjustsInsets><View><TextInput /></View></KeyboardAvoidingArea>; }',
      // Names reused by unrelated declarations are separate ways up.
      'function Row() { const content = <TextInput />; return <View>{content}</View>; }\nfunction Page() { const content = <ScrollView><Row /></ScrollView>; return <View>{content}</View>; }',
      'function Shell({ children }) { const body = <View>{children}</View>; return body; }\nfunction Page() { const body = <TextInput />; return <Shell>{body}</Shell>; }',
      // A component that draws what it is given in its own Overlay, however it reads it.
      'function Sheet({ open, children }) { return <Overlay visible={open}>{open ? children : null}</Overlay>; }\nfunction Page() { return <KeyboardAvoidingArea><Sheet open><TextInput /></Sheet></KeyboardAvoidingArea>; }',
      'function Sheet({ field }) { return <Overlay visible>{field}</Overlay>; }\nfunction Page() { return <KeyboardAvoidingArea><Sheet field={<TextInput />} /></KeyboardAvoidingArea>; }',
      'function Sheet(props) { return <Overlay visible {...props} />; }\nfunction Page() { return <KeyboardAvoidingArea><Sheet><TextInput /></Sheet></KeyboardAvoidingArea>; }',
      // One use covered and one not.
      'function Field() { return <TextInput />; }\nfunction Page() { return <View><KeyboardLift><Field /></KeyboardLift><Field /></View>; }',
      // A component that puts its children outside its area.
      'function Shell({ children }) { return <View><KeyboardAvoidingArea><Header /></KeyboardAvoidingArea>{children}</View>; }\nfunction Page() { return <Shell><TextInput /></Shell>; }',
    ];
    for (const source of unreached) expect(uncovered(source), source).not.toEqual([]);
  });

  it('passes a field that something makes room for', () => {
    const reached = [
      'function Page() { return <KeyboardAvoidingArea><ScrollView><TextInput /></ScrollView></KeyboardAvoidingArea>; }',
      'function Page() { return <KeyboardAvoidingArea iosScrollViewAdjustsInsets><ScrollView automaticallyAdjustKeyboardInsets><TextInput /></ScrollView></KeyboardAvoidingArea>; }',
      'function Page() { return <KeyboardAvoidingArea iosScrollViewAdjustsInsets><ScrollView automaticallyAdjustKeyboardInsets><ScrollView horizontal><TextInput /></ScrollView></ScrollView></KeyboardAvoidingArea>; }',
      // Outside any scroll view a field stays where its layout puts it on iOS (the model picker's search
      // field, above its list): that is not read here.
      'function Sheet() { return <KeyboardAvoidingArea iosScrollViewAdjustsInsets><TextInput /><ScrollView automaticallyAdjustKeyboardInsets /></KeyboardAvoidingArea>; }',
      'function Page() { return <KeyboardLift><TextInput /></KeyboardLift>; }',
      'function Page() { return <Screen keyboardAware><AppTextInput /></Screen>; }',
      // Inside a surface drawn elsewhere, with its own area.
      'function Sheet() { return <Overlay visible={p.rendered}><KeyboardAvoidingArea><TextInput /></KeyboardAvoidingArea></Overlay>; }',
      // Through a variable, a callback, a render prop and a memo.
      'function Page() { const field = <TextInput />; return <KeyboardAvoidingArea>{field}</KeyboardAvoidingArea>; }',
      'function Page() { return <KeyboardAvoidingArea>{rows.map((row) => <TextInput key={row} />)}</KeyboardAvoidingArea>; }',
      'function Page() { const renderRow = useCallback(() => <TextInput />, []); return <KeyboardAvoidingArea iosScrollViewAdjustsInsets><FlatList automaticallyAdjustKeyboardInsets renderItem={renderRow} /></KeyboardAvoidingArea>; }',
      'const Field = memo(() => <TextInput />);\nfunction Page() { return <KeyboardAvoidingArea><Field /></KeyboardAvoidingArea>; }',
      // A component that draws its children inside its area (the profile editor's form).
      'function Form({ children }) { return <KeyboardAvoidingArea iosScrollViewAdjustsInsets><ScrollView automaticallyAdjustKeyboardInsets>{children}</ScrollView></KeyboardAvoidingArea>; }\nfunction Page() { return <Form><AppTextInput /></Form>; }',
      // A prop drawn inside the component's area, and a plain wrapper that passes children on unread.
      'function Form({ field }) { return <KeyboardAvoidingArea>{field}</KeyboardAvoidingArea>; }\nfunction Page() { return <Form field={<TextInput />} />; }',
      'function Card(props) { return <View {...props} />; }\nfunction Page() { return <KeyboardAvoidingArea><Card><TextInput /></Card></KeyboardAvoidingArea>; }',
      // Each page of a horizontal pager with its own area.
      'function Pager() { return <FlatList horizontal renderItem={() => <KeyboardAvoidingArea><TextInput /></KeyboardAvoidingArea>} />; }',
      // The variable the Screen primitive uses, and a name reused in another component.
      'function Page() { const scroller = <ScrollView><TextInput /></ScrollView>; return <KeyboardAvoidingArea>{scroller}</KeyboardAvoidingArea>; }\nfunction Other() { const scroller = <View />; return scroller; }',
    ];
    for (const source of reached) expect(uncovered(source), source).toEqual([]);
  });

  it('reads the real tree', () => {
    // A positive control: a sweep that found no fields would pass the next test.
    const fields = tree.flatMap((file) => file.fields.map(({ field }) => field));
    expect(fields.length).toBeGreaterThanOrEqual(30);
    expect(fields.filter((field) => field.startsWith('app/post/new.tsx:')).length).toBeGreaterThanOrEqual(10);
    expect(fields.filter((field) => field.startsWith('components/media-creation-screen.tsx:')).length).toBeGreaterThanOrEqual(5);
  });

  it('gives every text field in app/ and components/ a way to clear the keyboard', () => {
    const unprotected = tree
      .filter(({ name }) => !PROVIDED_BY_ANCESTOR.has(name))
      .flatMap(({ fields }) => fields.flatMap(({ field, failures }) => failures.map((why) => `${field}: ${why}`)));

    expect(unprotected).toEqual([]);
  });

  it('pairs the iOS opt-out with the native prop it defers to', () => {
    // `iosScrollViewAdjustsInsets` makes the wrapper contribute nothing on iOS,
    // on the promise that a ScrollView inside carries
    // `automaticallyAdjustKeyboardInsets`. Half of that pairing is worse than
    // neither: the field simply stays under the keyboard on iOS. The sweep above
    // reads this per field in a scroll view; this holds a file whose area has none.
    const mismatched = screenFiles
      .map((filePath) => ({ filePath, source: readFileSync(filePath, 'utf8') }))
      .filter(({ source }) => source.includes('iosScrollViewAdjustsInsets')
        && !source.includes('automaticallyAdjustKeyboardInsets'))
      .map(({ filePath }) => relativePath(filePath));

    expect(mismatched).toEqual([]);
  });

  it('holds a hosted sheet’s area still while the sheet slides', () => {
    // A sheet that owns its entrance and exit (`useSheetPresentation`) slides
    // while a keyboard is leaving whenever it opens over the page's keyboard
    // or closes with its own up. An area that follows the keys then moves and
    // resizes the sheet at every frame of its slide: on the emulator a sheet
    // opened over a keyboard came into view part-way up, sank and rose again,
    // and the Reference details sheet did that on main (films, 2026-10-05).
    // So the area of every such sheet takes `followsKeyboard` from the
    // presentation that shows it.
    const areas = screenFiles
      .map((filePath) => ({ filePath, source: readFileSync(filePath, 'utf8') }))
      .flatMap(({ filePath, source }) => [...source.matchAll(/<Overlay visible=\{(\w+)\.rendered\}>([\s\S]*?)<\/Overlay>/g)]
        .flatMap(([, presentation, hosted]) => [...hosted.matchAll(/<KeyboardAvoidingArea\b[^>]*>/g)]
          .map(([tag]) => ({
            area: `${relativePath(filePath)}: ${tag.match(/testID="([^"]+)"/)?.[1] ?? tag.slice(0, 60)}`,
            held: tag.includes(`followsKeyboard={${presentation}.settled}`),
          }))));

    // The three there are today, so the search above is known to find them.
    expect(areas.map(({ area }) => area)).toEqual(expect.arrayContaining([
      'app/post/new.tsx: resource-editor-keyboard-area',
      'components/media-creation-screen.tsx: model-picker-keyboard-area',
      'components/media-creation-screen.tsx: reference-details-keyboard-area',
    ]));
    expect(areas.filter(({ held }) => !held).map(({ area }) => area)).toEqual([]);
  });

  it('keeps the avoidance geometry in one place', () => {
    // Two mechanisms drifting apart is how the original bug survived: several
    // screens each hand-rolled a keyboardDidShow listener and only some worked.
    const handRolled = screenFiles
      .map((filePath) => ({ filePath, source: readFileSync(filePath, 'utf8') }))
      // The shared module is where the listener belongs.
      .filter(({ filePath }) => relativePath(filePath) !== 'components/keyboard-aware.tsx')
      .filter(({ source }) => /addListener\(\s*['"]keyboard(Will|Did)(Show|Hide)['"]/.test(source))
      .map(({ filePath }) => relativePath(filePath));

    expect(handRolled).toEqual([]);
  });
});
