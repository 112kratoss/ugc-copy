import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import StudioOverflowMenu from '@/app/components/StudioOverflowMenu';

describe('StudioOverflowMenu', () => {
  it('keeps the secondary actions behind one named trigger and runs the chosen one', async () => {
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    render(
      <StudioOverflowMenu
        label="More actions for Sunset"
        items={[
          { key: 'download', label: 'Download creation', href: 'https://example.com/sunset.jpg', download: 'sunset.jpg' },
          { key: 'archive', label: 'Archive creation', tone: 'warning', onSelect: onArchive },
          { key: 'delete', label: 'Delete creation', tone: 'danger', onSelect: onDelete },
        ]}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'More actions for Sunset' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Nothing destructive is in the document until asked for.
    expect(screen.queryByRole('menuitem', { name: 'Delete creation' })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'More actions for Sunset' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Download creation', 'Archive creation', 'Delete creation']);
    // A download is a real anchor that saves the file rather than navigating.
    expect(items[0]).toHaveAttribute('href', 'https://example.com/sunset.jpg');
    expect(items[0]).toHaveAttribute('download', 'sunset.jpg');

    fireEvent.click(items[2]);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('moves with the arrow keys, closes on Escape back to the trigger, and holds a pending item', async () => {
    render(
      <StudioOverflowMenu
        label="More actions"
        items={[
          { key: 'archive', label: 'Archive post', onSelect: vi.fn() },
          { key: 'delete', label: 'Delete post', onSelect: vi.fn(), pending: true },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(items[0]).toHaveFocus();
    expect(items[1]).toBeDisabled();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('renders nothing without items', () => {
    const { container } = render(<StudioOverflowMenu label="More actions" items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
