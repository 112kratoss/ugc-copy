type AuthRouter<Href> = {
  canGoBack?: () => boolean;
  back: () => void;
  replace: (href: Href) => void;
};

export function normalizeAuthReturnTo(value: string | string[] | null | undefined) {
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim();
  if (
    !candidate
    || !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return null;
  }

  return candidate;
}

export function completeAuthScreen<Href>(
  router: AuthRouter<Href>,
  returnTo: string | string[] | null | undefined
) {
  const destination = normalizeAuthReturnTo(returnTo);
  if (destination) {
    router.replace(destination as unknown as Href);
    return;
  }

  leaveAuthScreen(router);
}

export function leaveAuthScreen<Href>(router: AuthRouter<Href>) {
  if (router.canGoBack?.()) {
    router.back();
    return;
  }

  router.replace('/(tabs)' as unknown as Href);
}
