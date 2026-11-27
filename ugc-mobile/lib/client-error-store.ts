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
 * build's handler ends the app, so a send started then never lands. The newest five are kept, and a
 * report leaves only once it was sent (`drop`), so a launch while offline loses nothing. Reads and
 * removals never throw.
 */
export function createClientErrorStore(): ClientErrorStore {
  return {
    async save(reports) {
      const kept = readKept(await AsyncStorage.getItem(CLIENT_ERROR_STORE_KEY));
      const next = [...kept, ...reports].slice(-CLIENT_ERROR_LIMITS.perSession);
      await AsyncStorage.setItem(CLIENT_ERROR_STORE_KEY, JSON.stringify(next));
    },
    async peek() {
      try {
        return readKept(await AsyncStorage.getItem(CLIENT_ERROR_STORE_KEY));
      } catch {
        return [];
      }
    },
    async drop(sent) {
      try {
        const sentKeys = new Set(sent.map((body) => JSON.stringify(body)));
        const left = readKept(await AsyncStorage.getItem(CLIENT_ERROR_STORE_KEY))
          .filter((body) => !sentKeys.has(JSON.stringify(body)));
        if (left.length > 0) await AsyncStorage.setItem(CLIENT_ERROR_STORE_KEY, JSON.stringify(left));
        else await AsyncStorage.removeItem(CLIENT_ERROR_STORE_KEY);
      } catch {
        // What could not be let go of is sent again at the next launch.
      }
    },
  };
}
