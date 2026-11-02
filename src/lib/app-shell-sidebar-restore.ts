/**
 * The half of the app shell's sidebar choice (`src/lib/app-shell-sidebar.ts`) that the root
 * layout, a server component, draws: the key the choice is kept under, and the inline script
 * that marks it on the root element ahead of the shell. Free of React, as a server component's
 * import must be of the client's hooks.
 */

/** The key a browser keeps the choice under: "hidden" once the sidebar was hidden. */
export const APP_SHELL_SIDEBAR_STORAGE_KEY = 'app-shell-sidebar';

/** Inline in the server's HTML, ahead of the shell: the choice kept in this browser, on the root element. */
export const APP_SHELL_SIDEBAR_RESTORE = `try{localStorage.getItem(${JSON.stringify(APP_SHELL_SIDEBAR_STORAGE_KEY)})==="hidden"&&(document.documentElement.dataset.sidebar="hidden")}catch(e){}`;
