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
 *   - nothing a person typed: the error's own text, the route's path without its query, and the
 *     app's version, update and platform. No prompt, no form value, no request body.
 *
 * Errors caught before the reporter is set (at launch, before the API client exists) wait here, up
 * to the session's five, and go once it is. Free of React Native imports, so it is tested directly;
 * `installGlobalErrorHandlers` is handed `ErrorUtils` and `HermesInternal` by the root layout.
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
};

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

function deliver(caught: Caught) {
  const reporter = state.reporter;
  if (!reporter) return;
  try {
    const context = reporter.context();
    const body: ClientErrorReportBody = {
      ...caught,
      route: routePath(context.route),
      appVersion: context.appVersion,
      updateId: context.updateId,
      platform: context.platform,
    };
    void Promise.resolve(reporter.send(body)).catch(() => undefined);
  } catch {
    // A report that cannot be made is dropped; the app goes on.
  }
}

/** Hands an error to the reporter. Never throws. */
export function reportClientError(
  error: unknown,
  { componentStack = null, fatal }: { componentStack?: string | null; fatal: boolean },
): void {
  try {
    if (state.dev || state.sent >= CLIENT_ERROR_LIMITS.perSession) return;
    const message = clip(safeString(error), CLIENT_ERROR_LIMITS.message) ?? 'Unknown error';
    const rawStack = error instanceof Error ? error.stack : null;
    const stack = clip(typeof rawStack === 'string' ? rawStack : null, CLIENT_ERROR_LIMITS.stack);
    const key = `${message}\n${stack?.slice(0, 500) ?? ''}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    state.sent += 1;
    const caught: Caught = {
      message,
      stack,
      componentStack: clip(componentStack, CLIENT_ERROR_LIMITS.componentStack),
      fatal,
    };
    if (state.reporter) deliver(caught);
    else state.waiting.push(caught);
  } catch {
    // Reporting must never be the next error.
  }
}

/** Sets where reports go, and sends what waited for it. Returns the unsetter. */
export function setClientErrorReporter(reporter: ClientErrorReporter): () => void {
  state.reporter = reporter;
  const waiting = state.waiting.splice(0);
  for (const caught of waiting) deliver(caught);
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
        reportClientError(error, { fatal: isFatal === true });
        previous?.(error, isFatal);
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
}
