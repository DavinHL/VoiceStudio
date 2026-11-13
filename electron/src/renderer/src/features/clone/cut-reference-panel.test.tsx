import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ trim: vi.fn() }));

vi.mock('@/hooks/use-profile-reference-tools', () => ({
  useTrimProfileAudio: () => ({ mutateAsync: mock.trim, isPending: false }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { CutReferencePanel } from './cut-reference-panel';
import type { Profile } from '@/lib/api/types';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const profile = {
  id: 'p1',
  name: 'Pong',
  kind: 'clone',
  ref_audio_path: 'p1.wav',
  ref_text: '',
  instruct: '',
  language: 'Auto',
  seed: null,
  personality: null,
  vd_states: null,
  created_at: 0,
  is_locked: 0,
  audio_url: '/api/profiles/p1/audio?v=1',
} as unknown as Profile;

it('stays a single button until the user opens the cut controls', () => {
  render(<CutReferencePanel profile={profile} durationSeconds={30} />);

  expect(screen.getByRole('button', { name: /clone.cut_reference/ })).toBeEnabled();
  expect(screen.queryByRole('slider', { name: 'clone.cut_start' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /clone.cut_reference/ }));

  expect(screen.getByRole('slider', { name: 'clone.cut_start' })).toBeInTheDocument();
  expect(screen.getByRole('slider', { name: 'clone.cut_end' })).toBeInTheDocument();
});

it('cannot be opened before the clip length is known', () => {
  render(<CutReferencePanel profile={profile} durationSeconds={null} />);

  // Without a duration the sliders would have no range to offer, and a guessed
  // end would cut the user's recording.
  expect(screen.getByRole('button', { name: /clone.cut_reference/ })).toBeDisabled();
});

it('cuts the chosen window and reports the width it keeps', async () => {
  mock.trim.mockResolvedValue({ ...profile, ref_audio_path: 'p1-new.wav' });
  render(<CutReferencePanel profile={profile} durationSeconds={30} />);
  fireEvent.click(screen.getByRole('button', { name: /clone.cut_reference/ }));

  fireEvent.change(screen.getByRole('slider', { name: 'clone.cut_start' }), {
    target: { value: '4' },
  });
  fireEvent.change(screen.getByRole('slider', { name: 'clone.cut_end' }), {
    target: { value: '12' },
  });

  expect(screen.getByText('clone.cut_keeps')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'clone.cut_apply' }));

  await waitFor(() =>
    expect(mock.trim).toHaveBeenCalledWith({
      id: 'p1',
      startS: 4,
      endS: 12,
      keepTranscript: false,
    }),
  );
  // A successful cut closes the panel again.
  await waitFor(() => expect(screen.queryByRole('slider', { name: 'clone.cut_start' })).toBeNull());
});

it('keeps the panel open and shows the reason when a cut fails', async () => {
  mock.trim.mockRejectedValue(new Error('That cut left almost no audio.'));
  render(<CutReferencePanel profile={profile} durationSeconds={30} />);
  fireEvent.click(screen.getByRole('button', { name: /clone.cut_reference/ }));
  fireEvent.change(screen.getByRole('slider', { name: 'clone.cut_end' }), {
    target: { value: '7' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'clone.cut_apply' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('That cut left almost no audio.');
  expect(screen.getByRole('slider', { name: 'clone.cut_start' })).toBeInTheDocument();
});

it('refuses to cut when nothing would be removed', () => {
  render(<CutReferencePanel profile={profile} durationSeconds={30} />);
  fireEvent.click(screen.getByRole('button', { name: /clone.cut_reference/ }));

  // Start 0 and end 30 is the whole clip, so there is nothing to cut.
  expect(screen.getByRole('button', { name: 'clone.cut_apply' })).toBeDisabled();
});

it('never lets a handle cross to an inverted window', () => {
  render(<CutReferencePanel profile={profile} durationSeconds={30} />);
  fireEvent.click(screen.getByRole('button', { name: /clone.cut_reference/ }));

  fireEvent.change(screen.getByRole('slider', { name: 'clone.cut_end' }), {
    target: { value: '10' },
  });
  // Dragging start past the end must stop at the minimum window, not invert.
  fireEvent.change(screen.getByRole('slider', { name: 'clone.cut_start' }), {
    target: { value: '25' },
  });

  expect(screen.getByRole('slider', { name: 'clone.cut_start' })).toHaveValue('9.5');
  expect(screen.getByRole('button', { name: 'clone.cut_apply' })).toBeEnabled();
});

it('sends keep_transcript only when the user asks for it', async () => {
  mock.trim.mockResolvedValue(profile);
  render(<CutReferencePanel profile={profile} durationSeconds={30} />);
  fireEvent.click(screen.getByRole('button', { name: /clone.cut_reference/ }));
  fireEvent.change(screen.getByRole('slider', { name: 'clone.cut_end' }), {
    target: { value: '9' },
  });
  fireEvent.click(screen.getByLabelText('clone.cut_keep_transcript'));
  fireEvent.click(screen.getByRole('button', { name: 'clone.cut_apply' }));

  await waitFor(() =>
    expect(mock.trim).toHaveBeenCalledWith(expect.objectContaining({ keepTranscript: true })),
  );
});
