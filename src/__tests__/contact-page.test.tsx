import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContactForm } from '@/app/contact/ContactForm';
import Contact from '@/app/contact/page';
import { TYPED_BEFORE_HYDRATION_CAPTURE } from '@/lib/typed-before-hydration';

describe('the contact page', () => {
    // A signed-in visitor's only help entry is "Help & feedback", which opens
    // this page; child safety and account deletion were linked nowhere they could see.
    it('links child safety and account deletion beside the policies', () => {
        render(<Contact />);

        const quickLinks = screen.getByRole('heading', { name: 'Quick Links' }).parentElement!;
        expect(within(quickLinks).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
            '/pricing',
            '/cancellation',
            '/terms',
            '/privacy',
            '/child-safety',
            '/delete-account',
        ]);
        expect(within(quickLinks).getByRole('link', { name: '→ Child Safety Standards' })).toBeInTheDocument();
        expect(within(quickLinks).getByRole('link', { name: '→ Delete Your Account' })).toBeInTheDocument();
    });
});

// The page is prerendered, so its form is in the HTML before any script runs, and what goes into
// it then reaches no React: React hydrated the fields without reading them back, and Send posted
// an empty form on the default subject (2026-11-05; tests/e2e/contact-typed-before-script.spec.ts).
describe('a contact form filled in before the page’s script ran', () => {
    const FILLED = { name: 'Early Visitor', email: 'early-visitor@example.com', subject: 'billing', message: 'Typed before the script.' };
    const recoverableErrors: unknown[] = [];
    const fetchMock = vi.fn();

    beforeAll(() => {
        // The root layout's capture, as the server's HTML runs it ahead of every field.
        new Function(TYPED_BEFORE_HYDRATION_CAPTURE)();
    });

    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Messages are paused.' }), { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        // The form hydrated: React never drew it again on the client, which would drop the text.
        expect(recoverableErrors.splice(0)).toEqual([]);
    });

    type Fields = { name: HTMLInputElement; email: HTMLInputElement; subject: HTMLSelectElement; message: HTMLTextAreaElement };

    /** Filling in the server's HTML: events no React hears. */
    function fillIn(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
        field.value = value;
        field.dispatchEvent(new Event(field.localName === 'select' ? 'change' : 'input', { bubbles: true }));
    }

    /** The form's server HTML, filled by `fill`, then hydrated. */
    function hydrateAfter(fill: (fields: Fields) => void) {
        const container = document.createElement('div');
        container.innerHTML = renderToString(<ContactForm />);
        document.body.appendChild(container);
        const fields: Fields = {
            name: container.querySelector('#name')!,
            email: container.querySelector('#email')!,
            subject: container.querySelector('#subject')!,
            message: container.querySelector('#message')!,
        };
        fill(fields);
        render(<ContactForm />, { container, hydrate: true, onRecoverableError: (error) => recoverableErrors.push(error) });
        return {
            fields,
            send: () => act(async () => {
                fireEvent.submit(container.querySelector('form')!);
            }),
        };
    }

    const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

    it('sends everything filled in, and the fields keep it', async () => {
        const form = hydrateAfter((fields) => {
            fillIn(fields.name, FILLED.name);
            fillIn(fields.email, FILLED.email);
            fillIn(fields.subject, FILLED.subject);
            fillIn(fields.message, FILLED.message);
        });

        await form.send();

        expect(sentBody()).toEqual(FILLED);
        expect(screen.getByRole('alert')).toHaveTextContent('Messages are paused.');
        expect(form.fields.name.value).toBe(FILLED.name);
        expect(form.fields.email.value).toBe(FILLED.email);
        expect(form.fields.subject.value).toBe(FILLED.subject);
        expect(form.fields.message.value).toBe(FILLED.message);
    });

    it('keeps a field filled in early when another is typed into once the script has run', async () => {
        const form = hydrateAfter((fields) => {
            fillIn(fields.email, FILLED.email);
        });
        fireEvent.change(form.fields.name, { target: { value: FILLED.name } });
        fireEvent.change(form.fields.message, { target: { value: FILLED.message } });

        await form.send();

        expect(sentBody()).toEqual({ ...FILLED, subject: 'general' });
        expect(form.fields.email.value).toBe(FILLED.email);
    });

    it('takes a message only as typed: text no input event brought is not sent', async () => {
        const form = hydrateAfter((fields) => {
            fields.message.value = 'Put back by the browser';
        });

        await form.send();

        expect(sentBody().message).toBe('');
    });
});
