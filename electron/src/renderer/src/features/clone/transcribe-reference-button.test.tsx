import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  transcribe: vi.fn(),
  isPending: false,
}));

vi.mock('@/hooks/use-profile-reference-tools', () => ({
  useTranscribeProfileReference: () => ({
    mutateAsync: mock.transcribe,
    isPending: mock.isPending,
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import type { Profile } from '@/lib/api/types';
import { TranscribeReferenceButton } from './transcribe-reference-button';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mock.isPending = false;
});

const profile = {
  id: 'voice1',
  name: 'Pong',
  ref_audio_path: 'voice1.mp3',
} as Profile;

it('transcribes this clip and hands the text to the editor', async () => {
  mock.transcribe.mockResolvedValue({ id: 'voice1', ref_text: 'Halo, Pong.', transcribed: true });
  const onTranscript = vi.fn();
  render(
    <TranscribeReferenceButton
      profile={profile}
      onTranscript={onTranscript}
      disabled={false}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /clone.transcribe_this/ }));

  // One clip, one call: the editor must not trigger the library-wide run.
  expect(mock.transcribe).toHaveBeenCalledWith('voice1');
  await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Halo, Pong.'));
});

it('leaves the editor alone when the clip turned out to be silent', async () => {
  mock.transcribe.mockResolvedValue({ id: 'voice1', ref_text: '', transcribed: false });
  const onTranscript = vi.fn();
  render(
    <TranscribeReferenceButton
      profile={profile}
      onTranscript={onTranscript}
      disabled={false}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /clone.transcribe_this/ }));

  // A blank result must not wipe text the user already typed.
  await waitFor(() => expect(mock.transcribe).toHaveBeenCalled());
  expect(onTranscript).not.toHaveBeenCalled();
});

it('stays inert for a voice with no reference clip', () => {
  render(
    <TranscribeReferenceButton
      profile={{ ...profile, ref_audio_path: '' } as Profile}
      onTranscript={vi.fn()}
      disabled={false}
    />,
  );

  const button = screen.getByRole('button', { name: /clone.transcribe_this/ });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('title', 'clone.transcribe_needs_reference');
});

it('reports a failed run instead of filling the field with an error', async () => {
  mock.transcribe.mockRejectedValue(new Error('no ASR'));
  const onTranscript = vi.fn();
  render(
    <TranscribeReferenceButton
      profile={profile}
      onTranscript={onTranscript}
      disabled={false}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /clone.transcribe_this/ }));

  // The hook owns the toast; the button must not reject into an unhandled promise.
  await waitFor(() => expect(mock.transcribe).toHaveBeenCalled());
  expect(onTranscript).not.toHaveBeenCalled();
});
