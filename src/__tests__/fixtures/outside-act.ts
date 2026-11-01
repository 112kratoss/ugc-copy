import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * Draws a page as a browser does, outside act(): React renders on its scheduler's own tasks, so a
 * read that answers in a microtask comes back before the render an effect's update asked for.
 * act() draws everything at once and never shows that order. `draw` renders into one root that
 * is unmounted, and its container removed, when `run` ends.
 */
export async function outsideAct<T>(run: (draw: (element: ReactElement) => void) => Promise<T>): Promise<T> {
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = false;
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  try {
    return await run((element) => root.render(element));
  } finally {
    root.unmount();
    container.remove();
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
}
