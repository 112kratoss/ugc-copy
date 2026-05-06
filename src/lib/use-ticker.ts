'use client';

import { useEffect, useState } from 'react';

function getCurrentTimeMs() {
  return Date.now();
}

export function useTicker(enabled: boolean, intervalMs = 1000) {
  const [nowMs, setNowMs] = useState(getCurrentTimeMs);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setNowMs(getCurrentTimeMs());
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, intervalMs]);

  return nowMs;
}
