'use client';

import { useEffect, useRef, useState } from 'react';

const VERSION_CHECK_INTERVAL_MS = 15000;
/**
 * How long a page stays hidden before it reloads onto a newer build: long
 * enough for a draft save the creator's last edit scheduled, or a file just
 * added, to finish writing.
 */
const HIDDEN_RELOAD_DELAY_MS = 10000;
const VERSION_RELOAD_MARKER_KEY = 'magicbooklet:deployment-refresh:last-build-id';
const LEGACY_VERSION_RELOAD_MARKER_KEYS = [
  'emptybooklet:deployment-refresh:last-build-id',
  'ugc:deployment-refresh:last-build-id',
];
/**
 * The build a page left when it reloaded to reach a newer one (`reloadForNewerBuild`). The
 * marker above names the build a tab reloads *for*, and only the version check writes it, once
 * it has heard of that build: never on a motion remix, which runs no check, nor on a page that
 * found itself out of date before its first check came back. Every page knows the build it
 * leaves, so the page that loads next can tell a reload that brought the same one back.
 */
const RELOADED_FROM_BUILD_KEY = 'magicbooklet:deployment-refresh:reloaded-from-build-id';

/**
 * The newer build this page has been told about. Module state lasts exactly as
 * long as the loaded page, across the hook turning off and on as runs start
 * and end, and is gone after the reload.
 */
let newerBuildIdForThisPage: string | null = null;

function getCurrentBuildId() {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.documentElement.dataset.buildId?.trim() || null;
}

function readSessionValue(key: string) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function getLastReloadedBuildId() {
  const storedBuildId = readSessionValue(VERSION_RELOAD_MARKER_KEY);
  if (storedBuildId) {
    return storedBuildId;
  }

  for (const key of LEGACY_VERSION_RELOAD_MARKER_KEYS) {
    const legacyBuildId = readSessionValue(key);
    if (legacyBuildId) {
      return legacyBuildId;
    }
  }

  return null;
}

function markReloadedBuild(buildId: string) {
  try {
    window.sessionStorage.setItem(VERSION_RELOAD_MARKER_KEY, buildId);
  } catch {
    // Without the marker a page served stale could offer the same reload again.
  }
}

function reloadPage() {
  window.location.reload();
}

/**
 * Reloads a page to reach a newer build, noting the build it leaves: a creator page that
 * found itself out of date, or one pressed after it heard of a newer build.
 */
export function reloadForNewerBuild(reload: () => void = reloadPage): void {
  const buildId = getCurrentBuildId();
  if (buildId) {
    try {
      window.sessionStorage.setItem(RELOADED_FROM_BUILD_KEY, buildId);
    } catch {
      // Without the note the next page cannot tell, and offers the reload again.
    }
  }
  reload();
}

/**
 * Whether this page is the very build a reload for a newer one left (a page served stale):
 * the same reload would only bring it back again.
 */
export function reloadBroughtBackThisBuild(): boolean {
  const buildId = getCurrentBuildId();
  return buildId !== null && readSessionValue(RELOADED_FROM_BUILD_KEY) === buildId;
}

type DeploymentRefreshOptions = {
  intervalMs?: number;
  reload?: () => void;
};

/**
 * Watches for a deploy newer than this page while `enabled` (the creator is
 * idle). It reloads the page only once it has stayed hidden, never under the
 * creator's eyes or mid-request: it used to switch on with the Generate press
 * and reload while the references uploaded or the start was in flight. A
 * visible page learns `newBuildAvailable` instead, and the creator saves its
 * draft and reloads at the next press rather than sending from an old build.
 */
export function useDeploymentRefresh(
  enabled: boolean,
  { intervalMs = VERSION_CHECK_INTERVAL_MS, reload = reloadPage }: DeploymentRefreshOptions = {},
): { newBuildAvailable: boolean } {
  const [newBuildAvailable, setNewBuildAvailable] = useState(() => newerBuildIdForThisPage !== null);
  // Held aside so a caller's inline function does not restart the checks on every render.
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const currentBuildId = getCurrentBuildId();
    if (!currentBuildId) {
      return;
    }

    let cancelled = false;
    let hiddenReloadTimer: number | null = null;

    const scheduleReloadWhileHidden = () => {
      if (hiddenReloadTimer !== null) {
        window.clearTimeout(hiddenReloadTimer);
        hiddenReloadTimer = null;
      }
      if (cancelled || !newerBuildIdForThisPage || document.visibilityState !== 'hidden') {
        return;
      }
      hiddenReloadTimer = window.setTimeout(() => {
        hiddenReloadTimer = null;
        if (!cancelled && newerBuildIdForThisPage && document.visibilityState === 'hidden') {
          reloadRef.current();
        }
      }, HIDDEN_RELOAD_DELAY_MS);
    };

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

        if (cancelled || !latestBuildId || latestBuildId === currentBuildId) {
          return;
        }

        if (latestBuildId !== newerBuildIdForThisPage) {
          // This tab already reloaded for that build and still runs the old
          // one (a page served stale): another reload would only loop.
          if (getLastReloadedBuildId() === latestBuildId) {
            return;
          }
          newerBuildIdForThisPage = latestBuildId;
          // Marked now, not at the reload, so a reload the creator makes at
          // the Generate press is covered too.
          markReloadedBuild(latestBuildId);
        }

        setNewBuildAvailable(true);
        scheduleReloadWhileHidden();
      } catch {
        // Ignore version check failures and keep the current session running.
      }
    };

    void refreshForNewBuild();
    const intervalId = window.setInterval(() => {
      void refreshForNewBuild();
    }, intervalMs);
    document.addEventListener('visibilitychange', scheduleReloadWhileHidden);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      if (hiddenReloadTimer !== null) {
        window.clearTimeout(hiddenReloadTimer);
      }
      document.removeEventListener('visibilitychange', scheduleReloadWhileHidden);
    };
  }, [enabled, intervalMs]);

  return { newBuildAvailable };
}
