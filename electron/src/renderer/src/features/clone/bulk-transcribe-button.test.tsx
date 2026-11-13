import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@/hooks/use-profile-reference-tools', () => ({
  useBulkTranscribeStatus: () => mock.status(),
  useStartBulkTranscribe: () => ({ mutate: mock.start, isPending: false }),
  useCancelBulkTranscribe: () => ({ mutate: mock.cancel, isPending: false }),
}));
vi.mock('@/hooks/use-tts-readiness', () => ({ useTtsReadiness: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { BulkTranscribeButton } from './bulk-transcribe-button';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const idle = { status: 'idle', total: 0, done: 0, skipped: 0, failed: 0, profiles: [] } as const;

it('offers to fill missing transcripts when nothing is running', () => {
  mock.status.mockReturnValue(idle);
  render(<BulkTranscribeButton />);

  fireEvent.click(screen.getByRole('button', { name: /clone.transcribe_missing/ }));

  // The default run leaves an existing transcript alone.
  expect(mock.start).toHaveBeenCalledWith(false);
});

it('replaces itself with progress and a cancel action while running', () => {
  mock.status.mockReturnValue({
    ...idle,
    status: 'running',
    total: 5,
    done: 2,
  });
  render(<BulkTranscribeButton />);

  expect(screen.getByRole('status')).toHaveTextContent('clone.transcribe_progress');
  expect(screen.queryByRole('button', { name: /clone.transcribe_missing/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /common.cancel/ }));
  expect(mock.cancel).toHaveBeenCalledOnce();
});

it('shows how many clips are still waiting', () => {
  mock.status.mockReturnValue({
    ...idle,
    status: 'running',
    total: 5,
    done: 2,
    skipped: 1,
  });
  render(<BulkTranscribeButton />);

  // Three of five are unaccounted for: two done plus one skipped leaves two.
  expect(screen.getByRole('status')).toHaveTextContent('clone.transcribe_remaining');
});

it('returns to the idle button once the run is done', () => {
  mock.status.mockReturnValue({ ...idle, status: 'done', total: 3, done: 2, skipped: 1 });
  render(<BulkTranscribeButton />);

  expect(screen.getByRole('button', { name: /clone.transcribe_missing/ })).toBeInTheDocument();
  expect(screen.queryByRole('status')).toBeNull();
});
