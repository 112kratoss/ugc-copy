export function leaveAuthScreen(router: {
  canGoBack?: () => boolean;
  back: () => void;
  replace: (href: '/(tabs)') => void;
}) {
  if (router.canGoBack?.()) {
    router.back();
    return;
  }

  router.replace('/(tabs)');
}
