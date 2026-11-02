import { useRoute } from '@react-navigation/native';
import { useEffect } from 'react';

import { publishScreenReturn } from './auth-navigation';

/**
 * Gives `path` as where a forced sign-in brings this screen back to while it is
 * in front (`publishScreenReturn`), until the path changes or the screen goes.
 * Null leaves the return to the screen's own params.
 */
export function useScreenReturn(path: string | null) {
  const { key } = useRoute();
  useEffect(() => (path ? publishScreenReturn(key, path) : undefined), [key, path]);
}
