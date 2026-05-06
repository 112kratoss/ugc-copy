import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StudioGenerationStatus } from '@/app/components/CreatorStudio';
import type { GenerationTiming } from '@/lib/generation-timing';

describe('StudioGenerationStatus', () => {
  it('shows an estimated countdown and live elapsed time for active runs', () => {
    const nowMs = Date.parse('2026-04-15T10:00:30.000Z');
    const timing: GenerationTiming = {
      appStatus: 'waiting',
      providerState: 'waiting',
      phaseLabel: 'Waiting for provider',
      startedAtMs: Date.parse('2026-04-15T10:00:00.000Z'),
      updatedAtMs: null,
      completedAtMs: null,
      elapsedMs: 5_000,
      completedInMs: null,
      estimatedTotalMs: 120_000,
    };

    render(<StudioGenerationStatus accent="blue" timing={timing} nowMs={nowMs} />);

    expect(screen.getByText('Waiting for provider')).toBeInTheDocument();
    expect(screen.getByText('Est. 01:30 left')).toBeInTheDocument();
    expect(screen.getByText('Elapsed 00:30')).toBeInTheDocument();
  });
});
