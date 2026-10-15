import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ResetPasswordPage from '@/app/auth/reset-password/page';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  getSession: vi.fn(),
  updateUser: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mocks.replace,
    refresh: mocks.refresh,
  }),
  useSearchParams: () => mocks.searchParams,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      updateUser: mocks.updateUser,
    },
  },
}));

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    mocks.replace.mockReset();
    mocks.refresh.mockReset();
    mocks.getSession.mockReset();
    mocks.updateUser.mockReset();
    mocks.searchParams = new URLSearchParams('next=/create');
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'recovery-session' } },
      error: null,
    });
    mocks.updateUser.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers a fresh recovery link when the session is missing or expired', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    render(<ResetPasswordPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/missing, expired, or already used/i);
    expect(screen.getByRole('link', { name: /request a new reset link/i })).toHaveAttribute(
      'href',
      '/login?returnUrl=%2Fcreate&recovery=1'
    );
    expect(screen.queryByLabelText(/new password/i)).not.toBeInTheDocument();
  });

  it('enforces the same visible password policy as signup', async () => {
    render(<ResetPasswordPage />);

    const password = await screen.findByLabelText(/new password/i);
    expect(screen.getByText('One uppercase letter')).toBeInTheDocument();
    expect(screen.getByText('One number')).toBeInTheDocument();
    expect(screen.getByText('One symbol')).toBeInTheDocument();

    fireEvent.change(password, { target: { value: 'alllowercase' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'alllowercase' },
    });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/uppercase letter.*number.*symbol/i);
    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(password).toHaveFocus();
  });

  it('updates the password and resumes the preserved route', async () => {
    mocks.searchParams = new URLSearchParams('next=/create/video?model=kling');
    render(<ResetPasswordPage />);

    const passwordInput = await screen.findByLabelText(/new password/i);
    fireEvent.change(passwordInput, {
      target: { value: 'Strong-password1!' },
    });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'Strong-password1!' },
    });
    vi.spyOn(window, 'setTimeout').mockImplementation((handler: (_: void) => void) => {
      handler();
      return {} as ReturnType<typeof setTimeout>;
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /update password/i }));
      await Promise.resolve();
    });

    expect(mocks.updateUser).toHaveBeenCalledWith({
      password: 'Strong-password1!',
    });
    expect(mocks.replace).toHaveBeenCalledWith('/create/video?model=kling');
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('recovers from a rejected password update request', async () => {
    mocks.updateUser.mockRejectedValue(new Error('Network unavailable'));
    render(<ResetPasswordPage />);

    const passwordInput = await screen.findByLabelText(/new password/i);
    fireEvent.change(passwordInput, { target: { value: 'Strong-password1!' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'Strong-password1!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update your password. Check your connection and try again.',
    );
    expect(screen.queryByText(/network unavailable/i)).toBeNull();
    expect(passwordInput).toHaveFocus();
    expect(screen.getByRole('button', { name: /update password/i })).toBeEnabled();
  });

  // Audit 01-9: the page printed Supabase's message as it came.
  it.each([
    [
      'New password should be different from the old password.',
      'Choose a password different from your current one.',
    ],
    [
      'Password update requires reauthentication.',
      'Could not update your password. Check your connection and try again.',
    ],
    [
      'Failed to fetch',
      'Could not reach the sign-in service. Check your connection and try again.',
    ],
  ])('says "%s" in the site\'s words', async (raw, shown) => {
    mocks.updateUser.mockResolvedValue({ error: Object.assign(new Error(raw), { name: 'AuthApiError', status: 422 }) });
    render(<ResetPasswordPage />);

    const passwordInput = await screen.findByLabelText(/new password/i);
    fireEvent.change(passwordInput, { target: { value: 'Strong-password1!' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'Strong-password1!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(shown);
    if (raw !== shown) expect(screen.queryByText(raw)).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
