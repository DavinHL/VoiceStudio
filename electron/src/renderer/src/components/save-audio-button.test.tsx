import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveExport: vi.fn(
    async (): Promise<{ canceled: boolean; path?: string; native?: boolean } | null> => ({
      canceled: true,
    }),
  ),
  bridge: { files: { revealPath: vi.fn() } } as object | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./bridge', () => ({ getBridge: () => mocks.bridge }));
vi.mock('@/lib/export-history', () => ({ saveExport: mocks.saveExport }));

import { audioMp3Url } from '@/lib/api/client';
import { toast } from 'sonner';
import { SaveAudioButton } from './save-audio-button';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.bridge = { files: { revealPath: vi.fn() } };
});

it('saves the WAV with one click and offers no format menu without an MP3 URL', async () => {
  render(<SaveAudioButton url="/audio/ab12cd34.wav" suggestedName="take.wav" />);
  expect(screen.queryByRole('button', { name: 'clone.download_format' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /clone\.download/ }));
  await waitFor(() =>
    expect(mocks.saveExport).toHaveBeenCalledWith('/audio/ab12cd34.wav', 'take.wav', { quiet: false }),
  );
});

it('exports the MP3 from the format menu under a matching file name', async () => {
  render(
    <SaveAudioButton
      url="/audio/ab12cd34.wav"
      mp3Url="/audio/ab12cd34.mp3"
      suggestedName="voicestudio-take.wav"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'clone.download_format' }));
  fireEvent.click(await screen.findByRole('button', { name: 'clone.download_mp3' }));
  await waitFor(() =>
    expect(mocks.saveExport).toHaveBeenCalledWith('/audio/ab12cd34.mp3', 'voicestudio-take.mp3', { quiet: false }),
  );
});

it('only derives an MP3 URL for backend renders', () => {
  expect(audioMp3Url('ab12cd34.wav')).toMatch(/\/audio\/ab12cd34\.mp3$/);
  expect(audioMp3Url('../secret.wav')).toBeUndefined();
  expect(audioMp3Url('ab12cd34.flac')).toBeUndefined();
});

it('stays clickable in a browser tab, where no desktop bridge exists', async () => {
  mocks.bridge = null;
  render(<SaveAudioButton url="/audio/ab12cd34.wav" suggestedName="take.wav" />);
  const button = screen.getByRole('button', { name: /clone\.download/ });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await waitFor(() =>
    expect(mocks.saveExport).toHaveBeenCalledWith('/audio/ab12cd34.wav', 'take.wav', { quiet: false }),
  );
});

it('offers the format menu without a bridge too', async () => {  mocks.bridge = null;
  render(
    <SaveAudioButton
      url="/audio/ab12cd34.wav"
      mp3Url="/audio/ab12cd34.mp3"
      suggestedName="take.wav"
    />,
  );
  const format = screen.getByRole('button', { name: 'clone.download_format' });
  expect(format).toBeEnabled();
  fireEvent.click(format);
  fireEvent.click(await screen.findByRole('button', { name: 'clone.download_mp3' }));
  await waitFor(() =>
    expect(mocks.saveExport).toHaveBeenCalledWith('/audio/ab12cd34.mp3', 'take.mp3', { quiet: false }),
  );
});

it('confirms a browser download by name, since the page cannot reveal it', async () => {
  mocks.bridge = null;
  mocks.saveExport.mockResolvedValueOnce({ canceled: false, path: 'take.wav' });
  render(<SaveAudioButton url="/audio/ab12cd34.wav" suggestedName="take.wav" />);

  fireEvent.click(screen.getByRole('button', { name: /clone\.download/ }));

  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('clone.downloaded_as'),
  );
});

it('stays quiet when the browser download is dismissed', async () => {
  mocks.bridge = null;
  mocks.saveExport.mockResolvedValueOnce({ canceled: true, path: '' });
  render(<SaveAudioButton url="/audio/ab12cd34.wav" suggestedName="take.wav" />);

  fireEvent.click(screen.getByRole('button', { name: /clone\.download/ }));

  await waitFor(() => expect(mocks.saveExport).toHaveBeenCalled());
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
});

it('keeps the native toast, with a reveal action, when the bridge writes the file', async () => {
  mocks.saveExport.mockResolvedValueOnce({ canceled: false, path: 'C:\\music\\take.wav' });
  render(<SaveAudioButton url="/audio/ab12cd34.wav" suggestedName="take.wav" />);

  fireEvent.click(screen.getByRole('button', { name: /clone\.download/ }));

  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith('clone.saved_to', expect.objectContaining({
      action: expect.objectContaining({ label: 'clone.reveal' }),
    })),
  );
});

it('explains an inert Save instead of looking broken, and still saves once ready', async () => {
  const { rerender } = render(
    <SaveAudioButton suggestedName="take.wav" disabledHint="voiceChanger.save_needs_result" />,
  );
  const inert = screen.getByRole('button', { name: 'voiceChanger.save_needs_result' });
  expect(inert).toBeDisabled();
  expect(inert).toHaveAttribute('title', 'voiceChanger.save_needs_result');

  rerender(<SaveAudioButton url="/audio/ab12cd34.wav" suggestedName="take.wav" />);
  const ready = screen.getByRole('button', { name: /clone\.download/ });
  expect(ready).toBeEnabled();
  expect(ready).not.toHaveAttribute('title');
  fireEvent.click(ready);
  await waitFor(() =>
    expect(mocks.saveExport).toHaveBeenCalledWith('/audio/ab12cd34.wav', 'take.wav', { quiet: false }),
  );
});

it('shows the plain label for a disabled Save with no hint', () => {
  render(<SaveAudioButton suggestedName="take.wav" />);
  const button = screen.getByRole('button', { name: /clone\.download/ });
  expect(button).toBeDisabled();
  expect(button).not.toHaveAttribute('title');
});
