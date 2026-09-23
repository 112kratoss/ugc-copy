import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StudioModelNotice, StudioRemixNotice } from '@/components/CreatorStudio';

describe('creator studio notices', () => {
  it('keeps the remix title on remix notices and gives model notices their own', () => {
    render(
      <>
        <StudioRemixNotice description={'Settings pre-filled from "Neon city".'} />
        <StudioModelNotice description="Model settings changed. Review the refreshed options before generating." />
      </>
    );

    const remixNotice = screen.getByText('Settings pre-filled from "Neon city".').closest('section');
    const modelNotice = screen.getByText(/Review the refreshed options/).closest('section');

    expect(remixNotice).toHaveTextContent('Remixing Community Creation');
    expect(modelNotice).toHaveTextContent('Model settings');
    expect(modelNotice).not.toHaveTextContent('Remixing Community Creation');
  });
});
