import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { VoiceChangerPage } from './voice-changer-page';

const mock = vi.hoisted(() => ({
  convert: vi.fn(),
  saveExport: vi.fn(
    async (): Promise<{ canceled: boolean; path: string } | null> => ({
      canceled: false,
      path: 'C:\\out\\take.wav',
    }),
  ),
  ready: true,
  cloning: true as boolean | null,
  backends: [] as { available: boolean; supports_voice_conversion?: boolean }[],
  profiles: [
    { id: 'a', name: 'Alpha', kind: 'clone', ref_audio_path: 'a.wav' },
    { id: 'b', name: 'Bravo', kind: 'clone', ref_audio_path: 'b.wav' },
  ] as { id: string; name: string; kind: string; ref_audio_path: string | null }[],
}));

vi.mock('@/hooks/use-engines', () => ({
  useEngines: () => ({
    isError: false,
    error: null,
    retry: vi.fn(),
    data: { tts: { backends: mock.backends } },
    activeTtsReady: mock.ready,
    activeTts: { supports_cloning: mock.cloning },
  }),
}));
vi.mock('@/hooks/use-profiles', () => ({
  useProfiles: () => ({ data: mock.profiles, isError: false, error: null, retry: vi.fn() }),
}));
vi.mock('@/lib/api/convert', () => ({ convertSpeech: mock.convert }));
vi.mock('@/lib/export-history', () => ({ saveExport: mock.saveExport }));
vi.mock('@/components/waveform-player', () => ({
  WaveformPlayer: () => <div data-testid="waveform" />,
}));
vi.mock('@/components/save-audio-button', () => ({
  SaveAudioButton: ({ url }: { url?: string }) => <button data-testid="save" data-url={url} />,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  // The workspace shell selects the current pathname; the page never routes.
  useRouterState: ({ select }: { select?: (state: { location: { pathname: string } }) => unknown } = {}) => {
    const state = { location: { pathname: '/voice-changer' } };
    return select ? select(state) : state;
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/clone/language-picker', () => ({
  LanguagePicker: () => <div data-testid="language-picker" />,
}));
vi.mock('@/features/tools/convert-languages', () => ({ CONVERT_SOURCE_LANGUAGES: [] }));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VoiceChangerPage />
    </QueryClientProvider>,
  );
}

function addClips(names: string[]) {
  const input = screen.getByLabelText('voiceChanger.add_files');
  const files = names.map((name) => new File([new Uint8Array(2048)], name, { type: 'audio/wav' }));
  fireEvent.change(input, { target: { files } });
}

const result = (text: string) => ({
  id: text,
  audio_url: `/audio/${text}.wav`,
  text,
  duration_s: 1,
  gen_time_s: 1,
});

// The workspace shell reads a media query for its compact layout; jsdom has no
// matchMedia, so every test gets a wide-viewport stand-in.
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  mock.convert.mockReset();
  mock.saveExport.mockClear();
  mock.ready = true;
  mock.cloning = true;
  mock.backends = [];
  mock.profiles = [
    { id: 'a', name: 'Alpha', kind: 'clone', ref_audio_path: 'a.wav' },
    { id: 'b', name: 'Bravo', kind: 'clone', ref_audio_path: 'b.wav' },
  ];
});

it('converts every queued clip into the selected voice, one after another', async () => {
  mock.convert.mockImplementation(async (file: File) => result(file.name));
  renderPage();
  addClips(['one.wav', 'two.wav']);

  fireEvent.click(screen.getByRole('button', { name: /voiceChanger.convert_all/ }));

  await waitFor(() => expect(screen.getAllByTestId('waveform')).toHaveLength(2));
  expect(mock.convert.mock.calls.map((call) => call[0].name)).toEqual(['one.wav', 'two.wav']);
  expect(mock.convert.mock.calls[0][1]).toBe('a');
});

it('stops the run: the next queued clip is never converted', async () => {
  // Held in an object so TypeScript keeps the callable type across the closure.
  const release: { current: (() => void) | null } = { current: null };
  mock.convert.mockImplementation(
    (file: File) =>
      new Promise((resolve, reject) => {
        if (file.name === 'one.wav') {
          release.current = () => resolve(result('one'));
          return;
        }
        // The second clip must never reach the engine once stopped.
        reject(new Error('second clip ran'));
      }),
  );
  renderPage();
  addClips(['one.wav', 'two.wav']);

  fireEvent.click(screen.getByRole('button', { name: /voiceChanger.convert_all/ }));
  const stop = await screen.findByRole('button', { name: /voiceChanger.stop/ });
  fireEvent.click(stop);
  release.current?.();

  await waitFor(() => expect(screen.queryByRole('button', { name: /voiceChanger.stop/ })).toBeNull());
  expect(mock.convert).toHaveBeenCalledTimes(1);
});

it('puts an aborted take back in the queue instead of reporting a failure', async () => {
  mock.convert.mockImplementation(
    (_file: File, _voice: string, _match: boolean, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
  );
  renderPage();
  addClips(['one.wav']);

  fireEvent.click(screen.getByRole('button', { name: /voiceChanger.convert_all/ }));
  fireEvent.click(await screen.findByRole('button', { name: /voiceChanger.stop/ }));

  await waitFor(() => expect(screen.queryByRole('button', { name: /voiceChanger.stop/ })).toBeNull());
  // No error row, and the clip is offered for another run.
  expect(screen.queryByText(/Abort/i)).toBeNull();
  expect(screen.getByRole('button', { name: /voiceChanger.convert_all/ })).not.toBeDisabled();
});

it('drops a selection that no longer exists', async () => {
  renderPage();
  // Select the second voice, then have it disappear (deleted in another tab).
  fireEvent.click(screen.getByRole('button', { name: /Bravo/ }));
  expect(screen.getByRole('button', { name: /Bravo/ })).toHaveAttribute('aria-pressed', 'true');

  mock.profiles = [{ id: 'a', name: 'Alpha', kind: 'clone', ref_audio_path: 'a.wav' }];
  cleanup();
  renderPage();

  // The page falls back to the surviving voice rather than holding a dead id.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Alpha/ })).toHaveAttribute('aria-pressed', 'true'),
  );
});

it('saves every finished take, skipping a cancelled dialog without aborting the rest', async () => {
  mock.convert.mockImplementation(async (file: File) => result(file.name));
  mock.saveExport
    .mockResolvedValueOnce(null) // the user closed the first dialog
    .mockResolvedValueOnce({ canceled: false, path: 'C:\\out\\two.wav' });
  renderPage();
  addClips(['one.wav', 'two.wav']);
  fireEvent.click(screen.getByRole('button', { name: /voiceChanger.convert_all/ }));
  await waitFor(() => expect(screen.getAllByTestId('waveform')).toHaveLength(2));

  fireEvent.click(screen.getByRole('button', { name: /voiceChanger.save_all/ }));
  await waitFor(() => expect(mock.saveExport).toHaveBeenCalledTimes(2));
});

it('cannot convert without a target voice or a usable engine', async () => {
  mock.ready = false;
  mock.cloning = false;
  mock.profiles = [];
  renderPage();
  addClips(['one.wav']);
  expect(screen.getByRole('button', { name: /voiceChanger.convert_all/ })).toBeDisabled();
});

it('offers Keep my delivery only when an engine converts speech to speech', () => {
  // Base UI's Switch exposes disability as `aria-disabled`, not the attribute.
  const { unmount } = renderPage();
  expect(screen.getByRole('switch', { name: /voiceChanger.keep_delivery/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  unmount();

  mock.backends = [{ available: true, supports_voice_conversion: true }];
  renderPage();
  expect(screen.getByRole('switch', { name: /voiceChanger.keep_delivery/ })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
});
