import 'server-only';

import { logBackendInfo } from '@/lib/backend-logger';

// Diagnostic logs contain only durations and fixed labels. Bound each scope to
// 20 records/minute/instance, retaining its first load and subsequent slow loads.
const scopes = new Map<string, { windowStart: number; count: number; seen: boolean }>();

export function createShowcaseLoadTiming(scope: 'page_data' | 'feed_refill') {
  const started = performance.now();
  const phases: Record<string, number> = {};
  return {
    record(phase: string, durationMs: number) {
      phases[phase] = Math.round((phases[phase] ?? 0) + durationMs);
    },
    async measure<T>(phase: string, work: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try {
        return await work();
      } finally {
        phases[phase] = Math.round(performance.now() - start);
      }
    },
    finish() {
      if (process.env.VERCEL_ENV !== 'production') return;
      const now = performance.now();
      const elapsedMs = Math.round(now - started);
      const state = scopes.get(scope) ?? { windowStart: now, count: 0, seen: false };
      const firstLoad = !state.seen;
      state.seen = true;
      if (now - state.windowStart >= 60_000) {
        state.windowStart = now;
        state.count = 0;
      }
      scopes.set(scope, state);
      if ((!firstLoad && elapsedMs < 500) || state.count >= 20) return;
      state.count++;
      logBackendInfo('showcase_load_timing', { scope, firstLoad, elapsedMs, phases });
    },
  };
}
