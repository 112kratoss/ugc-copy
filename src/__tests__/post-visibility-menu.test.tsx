import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PostVisibilityMenu from '@/components/PostVisibilityMenu';

describe('PostVisibilityMenu', () => {
  // A post is public or private since 2026-10-17 (decision 12).
  it('names the trigger after the current state and exposes a radio menu of public and private', async () => {
    const onChange = vi.fn();
    render(<PostVisibilityMenu value="private" onChange={onChange} label="Visibility of Sunset" />);

    const trigger = screen.getByRole('button', { name: 'Visibility of Sunset: Private' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Visibility of Sunset' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);

    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(items[0]).toHaveTextContent('Public');
    expect(items[0]).toHaveTextContent('In Explore and the feed.');
    expect(items[1]).toHaveTextContent('Private');
    expect(items[1]).toHaveTextContent('Only you.');
  });

  // The server stores a requested unlisted post as private; one saved before
  // then reads as what it is now, not as the first option.
  it('reads a post saved as unlisted as private, and offers no Unlisted', async () => {
    const onChange = vi.fn();
    render(<PostVisibilityMenu value="unlisted" onChange={onChange} label="Visibility of Sunset" />);

    const trigger = screen.getByRole('button', { name: 'Visibility of Sunset: Private' });
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Visibility of Sunset' });

    expect(within(menu).queryByRole('menuitemradio', { name: /unlisted/i })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: /private/i })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /public/i }));
    expect(onChange).toHaveBeenCalledWith('public');
  });

  it('reports a new choice, closes, and does nothing for the current one', async () => {
    const onChange = vi.fn();
    render(<PostVisibilityMenu value="public" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /change visibility/i }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: /public/i }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /change visibility/i }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: /private/i }));
    expect(onChange).toHaveBeenCalledWith('private');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on arrow keys, moves with them, selects with Enter, and closes on Escape back to the trigger', async () => {
    const onChange = vi.fn();
    render(<PostVisibilityMenu value="public" onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: /change visibility/i });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemradio');
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    // Wraps around from the first item to the last.
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes when the viewer clicks elsewhere', async () => {
    render(
      <>
        <p>Elsewhere</p>
        <PostVisibilityMenu value="public" onChange={vi.fn()} />
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: /change visibility/i }));
    await screen.findByRole('menu');
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('stays closed and shows progress while a change is in flight', () => {
    render(<PostVisibilityMenu value="private" onChange={vi.fn()} pending />);
    const trigger = screen.getByRole('button', { name: /change visibility/i });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
