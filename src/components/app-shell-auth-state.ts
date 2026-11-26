type AuthenticationListener = (authenticated: boolean) => void;

let currentAuthenticationState: boolean | null = null;
const listeners = new Set<AuthenticationListener>();

export function publishAppShellAuthentication(authenticated: boolean) {
  currentAuthenticationState = authenticated;
  listeners.forEach((listener) => listener(authenticated));
}

export function readAppShellAuthentication() {
  return currentAuthenticationState;
}

/** Back to "not checked yet", as a page load starts: for tests, which share this module. */
export function resetAppShellAuthenticationForTests() {
  currentAuthenticationState = null;
}

export function subscribeToAppShellAuthentication(listener: AuthenticationListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
