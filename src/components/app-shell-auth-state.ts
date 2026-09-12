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

export function subscribeToAppShellAuthentication(listener: AuthenticationListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
