/**
 * The app's own error reporter (audit 2026-11-27: errors on phones reached nobody). There is no
 * crash vendor by choice (`production-release-readiness.test.ts` pins "no Sentry"), so the root
 * error boundary, the global JS error handler and the unhandled-rejection tracker hand every error
 * here, and this sends it to `POST /api/mobile/client-errors` (`reportClientError` in
 * `contracts/mobile-api-v1.json`), which keeps it 30 days.
 *
 * The rules, all held by `__tests__/client-error-report.test.ts`:
 *   - it never throws, whatever it is handed and whatever the send does;
 *   - it is silent in development, where LogBox already shows everything;
 *   - message 500 characters, stack 4,000, component stack 2,000;
 *   - each distinct error once per app session, five reports per session at most;
 *   - a plain network failure (offline, aborted, timed out) is no report: it says nothing about
 *     the app, and five of them would use up the session;
 *   - the error's own text, the route's path without its query, and the app's version, update and
 *     platform. No form field, prompt or request body is sent, but an error's text can quote what
 *     it was handed (a server's message, text a parser could not read).
 *
 * Errors caught before the reporter is set (at launch, before the API client exists) wait here, up
 * to the session's five, and go once it is. A fatal error is kept on the device first
 * (`configureClientErrorStore`): a release build's handler ends the app, so a send started then
 * never lands. It is given at most `FATAL_SAVE_WAIT_MS` before the handler before it runs, and sent
 * at the next launch. Free of React Native imports, so it is tested directly; the root layout hands
 * `installGlobalErrorHandlers` `ErrorUtils` and `HermesInternal` and the store its AsyncStorage.
 */

export const CLIENT_ERROR_LIMITS = {
  message: 500,
  stack: 4_000,
  componentStack: 2_000,
  perSession: 5,
} as const;

export type ClientErrorContext = {
  route: string | null;
  appVersion: string | null;
  updateId: string | null;
  platform: 'ios' | 'android';
};

export type ClientErrorReportBody = ClientErrorContext & {
  message: string;
  stack: string | null;
  componentStack: string | null;
  fatal: boolean;
};

/** Where a fatal error's report waits for the next launch (`lib/client-error-store.ts`). */
export type ClientErrorStore = {
  save: (reports: ClientErrorReportBody[]) => Promise<void>;
  /** What is kept, left in place. */
  peek: () => Promise<ClientErrorReportBody[]>;
  /** Lets go of reports that were sent. */
  drop: (sent: ClientErrorReportBody[]) => Promise<void>;
};

/** The longest a fatal error waits for its report to be kept before the app ends as before. */
export const FATAL_SAVE_WAIT_MS = 1_000;

export type ClientErrorReporter = {
  send: (report: ClientErrorReportBody) => Promise<unknown> | unknown;
  context: () => ClientErrorContext;
};

type Caught = { message: string; stack: string | null; componentStack: string | null; fatal: boolean };

const state = {
  reporter: null as ClientErrorReporter | null,
  seen: new Set<string>(),
  sent: 0,
  waiting: [] as Caught[],
  installed: false,
  dev: typeof __DEV__ !== 'undefined' && __DEV__ === true,
  store: null as ClientErrorStore | null,
  storeContext: null as (() => ClientErrorContext) | null,
};

/** Keeps a fatal error's report for the next launch; `context` names where the app was. */
export function configureClientErrorStore(store: ClientErrorStore, context: () => ClientErrorContext): void {
  state.store = store;
  state.storeContext = context;
}

const NETWORK_FAILURE = /network request failed|request timed out|timed out after|aborted/iu;

/** Offline, aborted or timed out: a fetch that never got an answer, which is no fault of the app. */
function isNetworkFailure(error: unknown): boolean {
  try {
    if (!error || typeof error !== 'object') return typeof error === 'string' && NETWORK_FAILURE.test(error);
    const { name, message, status } = error as { name?: unknown; message?: unknown; status?: unknown };
    if (name === 'AbortError') return true;
    if (name === 'ApiError' && status === 0) return true;
    return typeof message === 'string' && NETWORK_FAILURE.test(message);
  } catch {
    return false;
  }
}

function safeString(value: unknown): string {
  try {
    if (value instanceof Error) return String(value);
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    return String(value);
  } catch {
    return 'Unreadable error';
  }
}

function clip(text: string | null | undefined, max: number): string | null {
  return typeof text === 'string' && text.length > 0 ? text.slice(0, max) : null;
}

function routePath(route: string | null): string | null {
  if (typeof route !== 'string') return null;
  const path = route.split(/[?#]/u, 1)[0] ?? '';
  return path.startsWith('/') ? path.slice(0, 200) : null;
}

function withContext(caught: Caught, context: ClientErrorContext): ClientErrorReportBody {
  return {
    ...caught,
    route: routePath(context.route),
    appVersion: context.appVersion,
    updateId: context.updateId,
    platform: context.platform,
  };
}

function send(body: ClientErrorReportBody) {
  try {
    void Promise.resolve(state.reporter?.send(body)).catch(() => undefined);
  } catch {
    // A report that cannot be sent is dropped; the app goes on.
  }
}

function deliver(caught: Caught) {
  const reporter = state.reporter;
  if (!reporter) return;
  try {
    send(withContext(caught, reporter.context()));
  } catch {
    // A report that cannot be made is dropped; the app goes on.
  }
}

/** The error as a report, or null where it is not reported (development, the cap, a repeat, the network). */
function capture(
  error: unknown,
  { componentStack = null, fatal }: { componentStack?: string | null; fatal: boolean },
): Caught | null {
  if (state.dev || state.sent >= CLIENT_ERROR_LIMITS.perSession || isNetworkFailure(error)) return null;
  const message = clip(safeString(error), CLIENT_ERROR_LIMITS.message) ?? 'Unknown error';
  const rawStack = error instanceof Error ? error.stack : null;
  const stack = clip(typeof rawStack === 'string' ? rawStack : null, CLIENT_ERROR_LIMITS.stack);
  const key = `${message}\n${stack?.slice(0, 500) ?? ''}`;
  if (state.seen.has(key)) return null;
  state.seen.add(key);
  state.sent += 1;
  return {
    message,
    stack,
    componentStack: clip(componentStack, CLIENT_ERROR_LIMITS.componentStack),
    fatal,
  };
}

/** Hands an error to the reporter. Never throws. */
export function reportClientError(
  error: unknown,
  options: { componentStack?: string | null; fatal: boolean },
): void {
  try {
    const caught = capture(error, options);
    if (!caught) return;
    if (state.reporter) deliver(caught);
    else state.waiting.push(caught);
  } catch {
    // Reporting must never be the next error.
  }
}

/** Keeps a fatal error's report on the device. Resolves once kept, or at once when there is none. */
function keepFatal(error: unknown): Promise<void> {
  try {
    const caught = capture(error, { fatal: true });
    const store = state.store;
    const context = state.reporter?.context ?? state.storeContext;
    if (!caught || !store || !context) return Promise.resolve();
    return Promise.resolve(store.save([withContext(caught, context())])).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

/** Sets where reports go, and sends what waited for it. Returns the unsetter. */
export function setClientErrorReporter(reporter: ClientErrorReporter): () => void {
  state.reporter = reporter;
  const waiting = state.waiting.splice(0);
  for (const caught of waiting) deliver(caught);
  // What a fatal error kept at an earlier launch, sent now and never counted against this session.
  // Each leaves the device only once its send succeeded; the rest wait for the next launch.
  try {
    const store = state.store;
    if (store && !state.dev) {
      void (async () => {
        const kept = await store.peek();
        const sent: ClientErrorReportBody[] = [];
        for (const body of (Array.isArray(kept) ? kept : []).slice(0, CLIENT_ERROR_LIMITS.perSession)) {
          try {
            await reporter.send(body);
            sent.push(body);
          } catch (error) {
            // Offline or busy: kept for the next launch. Refused as invalid (a 4xx other than a
            // rate limit): it would be refused at every launch, so it is let go of.
            const status = (error as { status?: unknown } | null)?.status;
            if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) sent.push(body);
          }
        }
        if (sent.length > 0) await store.drop(sent);
      })().catch(() => undefined);
    }
  } catch {
    // Kept reports wait for the next launch.
  }
  return () => {
    if (state.reporter === reporter) state.reporter = null;
  };
}

type ErrorUtilsLike = {
  getGlobalHandler: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => void;
};

type HermesLike = {
  enablePromiseRejectionTracker?: (options: {
    allRejections: boolean;
    onUnhandled: (id: number, error: unknown) => void;
    onHandled?: (id: number) => void;
  }) => void;
};

/**
 * The global JS error handler, wrapped so the handler before it (React Native's, which shows the
 * red screen in development and ends the app on a fatal error) still runs; and Hermes's
 * unhandled-rejection tracker, which React Native turns on only in development. Once per runtime,
 * and not in development, where both are React Native's own.
 */
export function installGlobalErrorHandlers({
  errorUtils,
  hermes,
}: {
  errorUtils: ErrorUtilsLike | null | undefined;
  hermes: HermesLike | null | undefined;
}): void {
  if (state.dev || state.installed) return;
  state.installed = true;
  try {
    if (errorUtils) {
      const previous = errorUtils.getGlobalHandler();
      errorUtils.setGlobalHandler((error, isFatal) => {
        if (isFatal !== true) {
          reportClientError(error, { fatal: false });
          previous?.(error, isFatal);
          return;
        }
        // A fatal error ends the app in the handler before this one: its report is kept on the
        // device first, for at most FATAL_SAVE_WAIT_MS, and the app then ends exactly as before.
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          previous?.(error, isFatal);
        };
        const timer = setTimeout(end, FATAL_SAVE_WAIT_MS);
        void keepFatal(error).then(() => {
          clearTimeout(timer);
          end();
        });
      });
    }
  } catch {
    // Without a handler the app runs as it did.
  }
  try {
    hermes?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id, error) => reportClientError(error, { fatal: false }),
      onHandled: () => undefined,
    });
  } catch {
    // Without the tracker the app runs as it did.
  }
}

export function resetClientErrorReportsForTests({ dev }: { dev: boolean }): void {
  state.reporter = null;
  state.seen.clear();
  state.sent = 0;
  state.waiting = [];
  state.installed = false;
  state.dev = dev;
  state.store = null;
  state.storeContext = null;
}
