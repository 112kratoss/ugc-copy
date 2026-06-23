export type RequestTraceContext = {
  requestId: string;
};

type AsyncLocalStorageLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
};

type AsyncHooksModule = {
  AsyncLocalStorage: new <T>() => AsyncLocalStorageLike<T>;
};

let requestTraceStorage: AsyncLocalStorageLike<RequestTraceContext> | null | undefined;
let fallbackRequestTrace: RequestTraceContext | null = null;

function loadRequestTraceStorage(): AsyncLocalStorageLike<RequestTraceContext> | null {
  if (requestTraceStorage !== undefined) {
    return requestTraceStorage;
  }

  const nodeProcess = typeof process === 'undefined'
    ? null
    : process as typeof process & {
      getBuiltinModule?: (id: string) => unknown;
    };
  const asyncHooks = nodeProcess?.getBuiltinModule?.('node:async_hooks') as AsyncHooksModule | undefined;
  requestTraceStorage = asyncHooks?.AsyncLocalStorage
    ? new asyncHooks.AsyncLocalStorage<RequestTraceContext>()
    : null;
  return requestTraceStorage;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return Boolean(value && typeof value === 'object' && 'then' in value && typeof value.then === 'function');
}

export function getActiveRequestTrace(): RequestTraceContext | null {
  return loadRequestTraceStorage()?.getStore() ?? fallbackRequestTrace;
}

export function withRequestTrace<T>(
  context: RequestTraceContext,
  operation: () => T
): T {
  const storage = loadRequestTraceStorage();
  if (storage) {
    return storage.run(context, operation);
  }

  const previousTrace = fallbackRequestTrace;
  fallbackRequestTrace = context;
  try {
    const result = operation();
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(() => {
        fallbackRequestTrace = previousTrace;
      }) as T;
    }
    fallbackRequestTrace = previousTrace;
    return result;
  } catch (error) {
    fallbackRequestTrace = previousTrace;
    throw error;
  }
}
