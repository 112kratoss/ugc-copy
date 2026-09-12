'use client';

import { useEffect, useState } from 'react';

interface NetworkInformationLike extends EventTarget {
  saveData?: boolean;
}

function getConnection(): NetworkInformationLike | null {
  if (typeof navigator === 'undefined') {
    return null;
  }

  return (navigator as Navigator & { connection?: NetworkInformationLike }).connection ?? null;
}

export function useMediaLoadingPreferences() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [saveData, setSaveData] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);
    updatePreference();
    mediaQuery.addEventListener?.('change', updatePreference);
    return () => mediaQuery.removeEventListener?.('change', updatePreference);
  }, []);

  useEffect(() => {
    const connection = getConnection();
    if (!connection) {
      return;
    }

    const updatePreference = () => setSaveData(Boolean(connection.saveData));
    updatePreference();
    connection.addEventListener?.('change', updatePreference);
    return () => connection.removeEventListener?.('change', updatePreference);
  }, []);

  return { prefersReducedMotion, saveData } as const;
}
