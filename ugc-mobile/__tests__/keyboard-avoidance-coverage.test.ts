import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
const SCROLLER = /(?:ScrollView|FlatList|SectionList|FlashList)$/;
/** Surfaces drawn somewhere else (the overlay host, a Modal's window): an area around one does not reach inside. */
const ELSEWHERE = new Set(['Overlay', 'Modal']);

type Walk = {
  /** Whether the field sits in a scroll view: only one can make the room on iOS. */
  scrolls: boolean;
  /** Whether one of the scroll views passed carries `automaticallyAdjustKeyboardInsets`. */
  adjustsInsets: boolean;
  trail: string[];
  /** In-file names already followed, so a component that draws itself is not followed forever. */
  followed: ReadonlySet<string>;
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
 * to an in-file component as children is followed from where that component
 * puts `children`. An area outside an `Overlay` or a `Modal` does not reach
 * the surface inside it, which is drawn elsewhere. And a field in a scroll
 * view that meets an area leaving iOS to `automaticallyAdjustKeyboardInsets`
 * has to pass a scroll view that carries it, or iOS gets nothing. (A field
 * outside any scroll view, as the model picker's search field above its list,
 * is where its sheet puts it on iOS; that is a matter of layout, not read here.)
 */
function sweep(name: string, source: string) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const tagOf = (element: ts.JsxElement | ts.JsxSelfClosingElement) =>
    (ts.isJsxElement(element) ? element.openingElement : element).tagName.getText(file);
  const attributesOf = (element: ts.JsxElement | ts.JsxSelfClosingElement) =>
    (ts.isJsxElement(element) ? element.openingElement : element).attributes;
  /** Present, and not written `={false}`. */
  const flagged = (element: ts.JsxElement | ts.JsxSelfClosingElement, wanted: string) =>
    attributesOf(element).properties.some((property) => ts.isJsxAttribute(property)
      && property.name.getText(file) === wanted
      && !(property.initializer
        && ts.isJsxExpression(property.initializer)
        && property.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword));

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

  /** Where an in-file component draws what it is given as children. */
  function childrenSlots(component: ts.FunctionLikeDeclaration): ts.Node[] {
    const slots: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxExpression(node) && node.expression) {
        const expression = node.expression;
        if ((ts.isIdentifier(expression) && expression.text === 'children')
          || (ts.isPropertyAccessExpression(expression) && expression.name.text === 'children')) {
          slots.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    if (component.body) visit(component.body);
    return slots;
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
    while (node && node !== boundary) {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = tagOf(node);
        if (tag === 'KeyboardAvoidingArea') {
          if (flagged(node, 'iosScrollViewAdjustsInsets') && current.scrolls && !current.adjustsInsets) {
            return fail(`the KeyboardAvoidingArea at line ${lineOf(node)} leaves iOS to a scroll view's automaticallyAdjustKeyboardInsets, and the field's scroll view does not carry it`);
          }
          return { failures: [], resumes: [] };
        }
        if (tag === 'KeyboardLift' || (tag === 'Screen' && flagged(node, 'keyboardAware'))) return { failures: [], resumes: [] };
        if (ELSEWHERE.has(tag)) return fail(`drawn in the ${tag} at line ${lineOf(node)} with nothing inside it giving way`);
        if (SCROLLER.test(tag)) {
          current = { ...current, scrolls: true, adjustsInsets: current.adjustsInsets || flagged(node, 'automaticallyAdjustKeyboardInsets') };
        }
        const component = functions.get(tag);
        if (ts.isJsxElement(node) && node.children.includes(previous as ts.JsxChild) && component && !current.followed.has(tag)) {
          // Children are drawn where the component puts them.
          const inside = { ...current, trail: [...current.trail, `${tag} children`], followed: new Set([...current.followed, tag]) };
          const outcomes = childrenSlots(component).map((slot) => follow(slot, inside, component));
          if (outcomes.length > 0) {
            const failures = outcomes.flatMap((outcome) => outcome.failures);
            const resumed = outcomes.flatMap((outcome) => outcome.resumes)
              .map((resume) => follow(node as ts.Node, { ...resume, trail: current.trail, followed: current.followed }, boundary));
            return {
              failures: [...failures, ...resumed.flatMap((outcome) => outcome.failures)],
              resumes: resumed.flatMap((outcome) => outcome.resumes),
            };
          }
        }
      }
      const bound = boundName(node);
      if (bound && (ts.isFunctionLike(node) || ts.isVariableDeclaration(node))) {
        if (current.followed.has(bound)) return { failures: [], resumes: [] };
        const declaration = ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)
          ? node
          : (() => {
            let holder: ts.Node = node.parent;
            while (!ts.isVariableDeclaration(holder)) holder = holder.parent;
            return holder;
          })();
        const uses = usesOf(bound, declaration);
        if (uses.length === 0) return fail(`nothing gives way on the way up to ${bound}`);
        const next = { ...current, followed: new Set([...current.followed, bound]) };
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
    return fail('nothing gives way on the way up to the file');
  }

  collect(file);
  return fields.map((field) => ({
    field: `${name}:${lineOf(field)} <${tagOf(field)}>`,
    failures: follow(field, { scrolls: false, adjustsInsets: false, trail: [], followed: new Set() }).failures,
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
    expect(composerShape).toContain('KeyboardAvoidingArea');
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
      // A Screen that does not opt in.
      'function Page() { return <Screen><AppTextInput /></Screen>; }',
      'function Page() { return <Screen keyboardAware={false}><AppTextInput /></Screen>; }',
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
