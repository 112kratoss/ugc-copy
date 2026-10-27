// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import WorkspaceCard from '@/app/home/WorkspaceCard';
import { announceGenerationStatusSynced } from '@/lib/generation-status-client';
import type { HomeWorkspaceGenerationView } from '@/lib/home-dashboard';

function buildView(overrides: Partial<HomeWorkspaceGenerationView> = {}): HomeWorkspaceGenerationView {
  return {
    id: 'gen-1',
    status: 'succeeded',
    category: 'image',
    model: 'nano-banana-2',
    origin: 'creation',
    title: 'Minnal Murali still',
    createdAt: '2026-07-20T10:00:00.000Z',
    completedAt: '2026-07-20T10:01:00.000Z',
    previewUrl: 'https://cdn.example/preview.jpg',
    mediaKind: 'image',
    outputCount: 1,
    isActive: false,
    isFailed: false,
    ...overrides,
  };
}

describe('WorkspaceCard', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('renders active runs with a live status row', () => {
    render(
      <WorkspaceCard
        initialGenerations={[
          buildView({
            id: 'active-1',
            status: 'processing',
            isActive: true,
            title: null,
            previewUrl: null,
            completedAt: null,
          }),
        ]}
      />,
    );

    expect(screen.getByText('Image · nano-banana-2')).toBeInTheDocument();
    // The balance is the top bar's alone.
    expect(screen.queryByText(/credits/)).not.toBeInTheDocument();
  });

  it('marks failed recents inline', () => {
    render(
      <WorkspaceCard
        initialGenerations={[buildView({ id: 'boom', status: 'failed', isFailed: true })]}
      />,
    );

    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('shows the empty state, and leaves a new creation to the top bar', () => {
    render(<WorkspaceCard initialGenerations={[]} />);

    expect(screen.getByText(/Nothing in flight yet/)).toBeInTheDocument();
    // The top bar's Create menu starts one; the card used to offer it again, with Studio twice.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('opens each recent creation in Studio, with one link to Studio itself', () => {
    render(
      <WorkspaceCard
        initialGenerations={[buildView({ id: 'gen 1' }), buildView({ id: 'gen-2', title: 'Second still' })]}
      />,
    );

    expect(screen.getByRole('link', { name: /Minnal Murali still/ })).toHaveAttribute('href', '/creations?generation=gen%201');
    expect(screen.getByRole('link', { name: /Second still/ })).toHaveAttribute('href', '/creations?generation=gen-2');
    expect(screen.getAllByRole('link', { name: /Studio/ }).map((link) => link.getAttribute('href'))).toEqual(['/creations']);
  });

  it('moves an active run into recents when a status sync reports success', () => {
    render(
      <WorkspaceCard
        initialGenerations={[
          buildView({
            id: 'active-1',
            status: 'processing',
            isActive: true,
            completedAt: null,
          }),
        ]}
      />,
    );

    expect(screen.getByText('Minnal Murali still')).toBeInTheDocument();

    act(() => {
      // Mirror the poller: it writes the session cache first, then fires the
      // broadcast that notifies this card's external store.
      window.sessionStorage.setItem(
        'magicbooklet:generation-status-cache:v1',
        JSON.stringify({ 'active-1': 'succeeded' }),
      );
      announceGenerationStatusSynced([
        { id: 'active-1', status: 'succeeded', completed_at: '2026-07-20T10:02:00.000Z' },
      ]);
    });

    // The run leaves the active list (no live status row) and lands in the
    // recents grid as a thumbnail link.
    expect(screen.queryByText('Minnal Murali still')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Minnal Murali still/ })).toBeInTheDocument();
  });

  it('applies a pre-hydration poll from the session cache', () => {
    window.sessionStorage.setItem(
      'magicbooklet:generation-status-cache:v1',
      JSON.stringify({ 'active-1': 'failed' }),
    );

    render(
      <WorkspaceCard
        initialGenerations={[
          buildView({ id: 'active-1', status: 'processing', isActive: true, completedAt: null }),
        ]}
      />,
    );

    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('renders the compact inline variant with an active count', () => {
    render(
      <WorkspaceCard
        initialGenerations={[
          buildView({ id: 'a', status: 'processing', isActive: true, completedAt: null }),
          buildView({ id: 'b', status: 'waiting', isActive: true, completedAt: null }),
        ]}
        variant="inline"
      />,
    );

    expect(screen.getByText('2 renders in progress')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Studio' })).toHaveAttribute('href', '/creations');
  });

  it('draws no inline strip while nothing renders', () => {
    const { container } = render(<WorkspaceCard initialGenerations={[buildView()]} variant="inline" />);

    expect(container).toBeEmptyDOMElement();
  });

  describe('the clock', () => {
    function atRailWidth(matches: boolean) {
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
    }

    const running = [buildView({ id: 'active-1', status: 'processing', isActive: true, completedAt: null })];
    const secondTicks = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([, delay]) => delay === 1000);

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('ticks in the rail, which shows how long each run has taken', () => {
      atRailWidth(true);
      const setIntervalSpy = vi.spyOn(window, 'setInterval');

      render(<WorkspaceCard initialGenerations={running} variant="rail" />);

      expect(secondTicks(setIntervalSpy)).toHaveLength(1);
    });

    // The strip a phone shows reads no clock, and its tick re-rendered Home
    // every second while a run was in progress.
    it('never ticks in the inline strip, which shows only a count', () => {
      atRailWidth(false);
      const setIntervalSpy = vi.spyOn(window, 'setInterval');

      render(<WorkspaceCard initialGenerations={running} variant="inline" />);

      expect(screen.getByText('1 render in progress')).toBeInTheDocument();
      expect(secondTicks(setIntervalSpy)).toHaveLength(0);
    });
  });
});
