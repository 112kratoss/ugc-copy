'use client';

import { useEffect } from 'react';

const VERSION_CHECK_INTERVAL_MS = 15000;
const VERSION_RELOAD_MARKER_KEY = 'ugc:deployment-refresh:last-build-id';

function getCurrentBuildId() {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.documentElement.dataset.buildId?.trim() || null;
}

export function useDeploymentRefresh(enabled: boolean, intervalMs = VERSION_CHECK_INTERVAL_MS) {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const currentBuildId = getCurrentBuildId();
    if (!currentBuildId) {
      return;
    }

    let cancelled = false;

    const refreshForNewBuild = async () => {
      try {
        const response = await fetch('/api/app-version', {
          cache: 'no-store',
        });

        if (!response.ok || cancelled) {
          return;
        }

        const data = await response.json() as { buildId?: string | null };
        const latestBuildId = data.buildId?.trim();

        if (!latestBuildId || latestBuildId === currentBuildId) {
          return;
        }

        const lastReloadedBuildId = window.sessionStorage.getItem(VERSION_RELOAD_MARKER_KEY);
        if (lastReloadedBuildId === latestBuildId) {
          return;
        }

        window.sessionStorage.setItem(VERSION_RELOAD_MARKER_KEY, latestBuildId);
        window.location.reload();
      } catch {
        // Ignore version check failures and keep the current session running.
      }
    };

    void refreshForNewBuild();
    const intervalId = window.setInterval(() => {
      void refreshForNewBuild();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs]);
}
