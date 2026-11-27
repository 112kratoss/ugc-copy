import AsyncStorage from '@react-native-async-storage/async-storage';

import { CLIENT_ERROR_LIMITS, type ClientErrorReportBody, type ClientErrorStore } from './client-error-report';

export const CLIENT_ERROR_STORE_KEY = 'magicbooklet.client-errors.pending.v1';

function readKept(raw: string | null): ClientErrorReportBody[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ClientErrorReportBody[]) : [];
  } catch {
    return [];
  }
}

/**
 * Where a fatal error's report waits for the next launch (`lib/client-error-report.ts`): a release
 * build's handler ends the app, so a send started then never lands. The newest five are kept.
 */
export function createClientErrorStore(): ClientErrorStore {
  return {
    async save(reports) {
      const kept = readKept(await AsyncStorage.getItem(CLIENT_ERROR_STORE_KEY));
      const next = [...kept, ...reports].slice(-CLIENT_ERROR_LIMITS.perSession);
      await AsyncStorage.setItem(CLIENT_ERROR_STORE_KEY, JSON.stringify(next));
    },
    async take() {
      try {
        const kept = readKept(await AsyncStorage.getItem(CLIENT_ERROR_STORE_KEY));
        if (kept.length > 0) await AsyncStorage.removeItem(CLIENT_ERROR_STORE_KEY);
        return kept;
      } catch {
        return [];
      }
    },
  };
}
