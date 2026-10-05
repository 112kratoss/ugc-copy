import { createRequire, Module } from 'node:module';
import type React from 'react';

/**
 * React Native's own renderer, the file that ships in the app, mounted over a
 * stand-in for the native side: enough to draw host views and send them
 * touches, so a test can ask the real responder system who is given a touch.
 *
 * The suites beside this one double `react-native` itself, because its entry
 * is Flow, which vitest cannot parse. A double hands a test the handlers a
 * component passed; it cannot say what React Native then does with their
 * answers: who is asked next, who ends up holding the touch, who is asked
 * about the touch after it. That is decided in the renderer, which is plain
 * JavaScript, so it runs here as it is. Its two links to the rest of React
 * Native (the private interface and the native UI manager) are answered below.
 *
 * Nothing is aliased for other suites: the renderer is loaded by path, into
 * the test file that asks for it.
 */
const nodeRequire = createRequire(import.meta.url);

const RENDERERS = {
  /** What a store build and an update run. */
  production: 'react-native/Libraries/Renderer/implementations/ReactFabric-prod.js',
  /** What a development build runs. */
  development: 'react-native/Libraries/Renderer/implementations/ReactFabric-dev.js',
};
export type RendererBuild = keyof typeof RENDERERS;

const ROOT_TAG = 11;

/** A host view. Its `testID` is how a test names it when sending a touch. */
export const HostView = 'RCTView' as unknown as React.ComponentType<{ testID?: string; children?: React.ReactNode } & Record<string, unknown>>;

type TouchPhase = 'start' | 'move' | 'end' | 'cancel';
type ShadowNode = { tag: number; testID?: string };
type FabricRenderer = {
  render: (element: React.ReactElement, containerTag: number, callback: null, concurrentRoot: boolean) => unknown;
  unmountComponentAtNode: (containerTag: number) => void;
};

/** Answers one of the renderer's own `require` calls with a stand-in. */
function provide(specifier: string, exports: unknown) {
  const filename = nodeRequire.resolve(specifier);
  const standIn = new Module(filename);
  standIn.filename = filename;
  standIn.exports = exports;
  standIn.loaded = true;
  nodeRequire.cache[filename] = standIn;
}

const touchEvents = Object.fromEntries(['Start', 'Move', 'End', 'Cancel'].map(phase => [
  `topTouch${phase}`,
  { phasedRegistrationNames: { bubbled: `onTouch${phase}`, captured: `onTouch${phase}Capture` } },
]));

export function createResponderHost(build: RendererBuild = 'production') {
  const views = new Map<string, { fiber: unknown; tag: number }>();
  let dispatch: ((target: unknown, type: string, nativeEvent: object) => void) | undefined;
  let jsResponder: string | null = null;
  let clock = 1000;

  const copy = (node: ShadowNode) => ({ ...node });
  const host = globalThis as unknown as { nativeFabricUIManager?: unknown; __DEV__?: boolean };
  host.__DEV__ = build === 'development';
  host.nativeFabricUIManager = {
    registerEventHandler: (handler: typeof dispatch) => { dispatch = handler; },
    createNode: (tag: number, _viewName: string, _rootTag: number, props: { testID?: string } | null, fiber: unknown): ShadowNode => {
      if (props?.testID) views.set(props.testID, { fiber, tag });
      return { tag, testID: props?.testID };
    },
    cloneNode: copy,
    cloneNodeWithNewChildren: copy,
    cloneNodeWithNewProps: copy,
    cloneNodeWithNewChildrenAndProps: copy,
    createChildSet: () => [],
    appendChild: () => {},
    appendChildToSet: () => {},
    completeRoot: () => {},
    // What Android acts on: the view it is told holds the touch intercepts the native one.
    setIsJSResponder: (node: ShadowNode, isResponder: boolean) => {
      if (isResponder) jsResponder = node.testID ?? `#${node.tag}`;
      else if (jsResponder === (node.testID ?? `#${node.tag}`)) jsResponder = null;
    },
  };
  provide('react-native/Libraries/ReactPrivate/ReactNativePrivateInitializeCore', {});
  provide('react-native/Libraries/ReactPrivate/ReactNativePrivateInterface', {
    ReactNativeViewConfigRegistry: {
      customBubblingEventTypes: touchEvents,
      customDirectEventTypes: {},
      get: () => ({ uiViewClassName: 'RCTView', validAttributes: { testID: true }, bubblingEventTypes: touchEvents, directEventTypes: {} }),
    },
    createPublicInstance: (tag: number) => ({ tag }),
    createPublicRootInstance: (tag: number) => ({ tag }),
    createPublicTextInstance: () => ({}),
    createAttributePayload: (props: { testID?: string }) => ({ testID: props.testID }),
    diffAttributePayloads: () => null,
    getNativeTagFromPublicInstance: (instance: { tag: number }) => instance.tag,
    getNodeFromPublicInstance: () => null,
    deepFreezeAndThrowOnMutationInDev: () => {},
    legacySendAccessibilityEvent: () => {},
    RawEventEmitter: { emit: () => {} },
    ReactFiberErrorDialog: { showErrorDialog: () => true },
    UIManager: {},
  });

  // A renderer of its own for every host: who holds a touch is kept in the renderer's module.
  const rendererPath = nodeRequire.resolve(RENDERERS[build]);
  delete nodeRequire.cache[rendererPath];
  const renderer = nodeRequire(rendererPath) as FabricRenderer;

  return {
    /** Draws the tree. */
    mount(tree: React.ReactElement) {
      renderer.render(tree, ROOT_TAG, null, false);
      if (views.size === 0) throw new Error('The renderer drew nothing: no view with a testID was mounted.');
    },
    /**
     * One native touch event of one finger, on the view with this `testID`:
     * the view the native side found under the finger when it came down. An
     * `end` or a `cancel` leaves no finger on the screen.
     */
    touch(phase: TouchPhase, testID: string, at: { x?: number; y?: number } = {}) {
      const view = views.get(testID);
      if (!view || !dispatch) throw new Error(`No view "${testID}" is mounted.`);
      const finger = { identifier: 0, target: view.tag, pageX: at.x ?? 0, pageY: at.y ?? 0, locationX: at.x ?? 0, locationY: at.y ?? 0, timestamp: (clock += 16) };
      const lifted = phase === 'end' || phase === 'cancel';
      dispatch(view.fiber, `topTouch${phase[0].toUpperCase()}${phase.slice(1)}`, { ...finger, changedTouches: [finger], touches: lifted ? [] : [finger] });
    },
    /** The `testID` of the view the native side was last told holds the touch for JS, or null. */
    responder: () => jsResponder,
    unmount() {
      renderer.unmountComponentAtNode(ROOT_TAG);
    },
  };
}

export type ResponderHost = ReturnType<typeof createResponderHost>;
