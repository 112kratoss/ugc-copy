import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import RecoverableMediaAudio from '@/components/RecoverableMediaAudio';
afterEach(cleanup);
it('retries expired stored audio through authenticated media delivery without replaying automatically', async () => {
  const src = 'https://storage.example.com/storage/v1/object/sign/generated_audio/owner/clip.wav?token=expired';
  const { container } = render(<RecoverableMediaAudio src={src} autoPlay />);
  expect(container.querySelector('audio')).toHaveAttribute('autoplay');
  fireEvent.error(container.querySelector('audio')!);
  fireEvent.click(screen.getByRole('button', { name: 'Reload audio' }));
  await waitFor(() => expect(container.querySelector('audio')).toHaveAttribute('src', '/api/media?bucket=generated_audio&path=owner%2Fclip.wav'));
  expect(container.querySelector('audio')).not.toHaveAttribute('autoplay');
});
