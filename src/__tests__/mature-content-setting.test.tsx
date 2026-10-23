import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MatureContentSetting from '@/app/profile/MatureContentSetting';
import FeedbackViewport from '@/components/FeedbackViewport';

type SentRequest = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

describe('MatureContentSetting', () => {
  let sent: SentRequest[];
  let storedShowMature: boolean;
  let failNextRead: boolean;
  let failNextChange: boolean;

  beforeEach(() => {
    sent = [];
    storedShowMature = false;
    failNextRead = false;
    failNextChange = false;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, init });
      if (url !== '/api/content-preferences') throw new Error(`Unexpected request: ${url}`);
      if (init?.method === 'POST') {
        if (failNextChange) {
          failNextChange = false;
          return jsonResponse({ error: 'Could not update mature-content preferences. Please retry.' }, 500);
        }
        const body = JSON.parse(String(init.body)) as { showMature: boolean };
        storedShowMature = body.showMature;
        return jsonResponse({ showMature: storedShowMature });
      }
      if (failNextRead) {
        failNextRead = false;
        return jsonResponse({ error: 'Could not update mature-content preferences. Please retry.' }, 500);
      }
      return jsonResponse({ showMature: storedShowMature });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const posts = () => sent.filter((request) => request.init?.method === 'POST');

  it('reads the setting and turns it on only after the 18+ question, from the cookie session', async () => {
    render(
      <>
        <MatureContentSetting />
        <FeedbackViewport />
      </>
    );

    const toggle = await screen.findByRole('switch', { name: 'Mature content' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(sent[0].init).toMatchObject({ cache: 'no-store' });

    // Declined: nothing is sent and the setting stays off.
    fireEvent.click(toggle);
    let question = await screen.findByRole('alertdialog', { name: 'Turn on mature content?' });
    expect(question).toHaveAccessibleDescription(
      'Confirm that you are 18 or older. NSFW posts stay covered until you choose to reveal one.',
    );
    fireEvent.click(within(question).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(posts()).toHaveLength(0);
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);
    question = await screen.findByRole('alertdialog', { name: 'Turn on mature content?' });
    fireEvent.click(within(question).getByRole('button', { name: 'I’m 18 or older' }));

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0].init?.body))).toEqual({ showMature: true, confirmAdult: true });
    // The route refuses a bearer call; the website's cookie session carries it.
    expect(posts()[0].init?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('turns it off without a question', async () => {
    storedShowMature = true;
    const confirm = vi.spyOn(window, 'confirm');
    render(<MatureContentSetting />);
    const toggle = await screen.findByRole('switch', { name: 'Mature content' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(confirm).not.toHaveBeenCalled();
    expect(JSON.parse(String(posts()[0].init?.body))).toEqual({ showMature: false });
  });

  it('keeps the setting and says so when the change fails', async () => {
    storedShowMature = true;
    failNextChange = true;
    render(<MatureContentSetting />);
    const toggle = await screen.findByRole('switch', { name: 'Mature content' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    fireEvent.click(toggle);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update mature-content preferences. Please retry.');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toBeEnabled();
  });

  it('offers Retry when the setting does not load, and reads it again', async () => {
    failNextRead = true;
    render(<MatureContentSetting />);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    const toggle = await screen.findByRole('switch', { name: 'Mature content' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(sent.filter((request) => request.init?.method !== 'POST')).toHaveLength(2);
  });

  // Effects run twice under Strict Mode, as under <Activity> going hidden and
  // visible: the first read is abandoned and the second one is drawn.
  it('draws the setting when its effect runs twice', async () => {
    storedShowMature = true;
    render(<StrictMode><MatureContentSetting /></StrictMode>);

    const toggle = await screen.findByRole('switch', { name: 'Mature content' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
