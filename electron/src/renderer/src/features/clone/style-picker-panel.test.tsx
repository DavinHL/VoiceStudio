import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_CLONE_SETTINGS, patchCloneSettings } from '@/lib/store/clone-settings';

const engines = vi.hoisted(() => ({ activeTts: null as Record<string, unknown> | null }));
vi.mock('@/hooks/use-engines', () => ({ useEngines: () => ({ activeTts: engines.activeTts }) }));
vi.mock('@/hooks/use-profiles', () => ({
  useCreateCloneProfile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useProfiles: () => ({ data: [] }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => children }));
vi.mock('./portrait-search', () => ({ PortraitSearch: () => null }));
vi.mock('./profile-image-editor', () => ({ ProfileImageEditor: () => null }));
import { OptionalDetails } from './reference-panel';

/** A non-empty transcription state is what auto-opens the collapsible. */
const opened = { state: 'unavailable', recommended: null, retry: vi.fn() } as const;

beforeEach(() => {
  patchCloneSettings({ ...DEFAULT_CLONE_SETTINGS, instruct: '' });
});

afterEach(() => {
  cleanup();
  engines.activeTts = null;
});

it('offers the closed vocabulary as chips for an engine that only accepts tags', () => {
  engines.activeTts = { id: 'omnivoice', instruct_vocabulary: 'tags', display_name: 'OmniVoice' };
  render(<OptionalDetails transcription={{ ...opened }} />);

  const picker = document.querySelector('[data-style-picker]');
  expect(picker).not.toBeNull();
  // The free-text field is gone: prose here is what the engine silently drops.
  expect(screen.queryByRole('textbox', { name: 'clone.style' })).toBeNull();
  expect(screen.getByRole('button', { name: 'clone.opt_male' })).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: 'clone.opt_male' }));
  expect(screen.getByRole('button', { name: 'clone.opt_male' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
});

it('keeps the free-text field for an engine that takes prose direction', () => {
  engines.activeTts = { id: 'cosyvoice3', instruct_vocabulary: 'freeform', display_name: 'CosyVoice 3' };
  render(<OptionalDetails transcription={{ ...opened }} />);

  expect(document.querySelector('[data-style-picker]')).toBeNull();
  const field = screen.getByRole('textbox', { name: 'clone.style' });
  fireEvent.change(field, { target: { value: 'warm and unhurried' } });
  expect((field as HTMLInputElement).value).toBe('warm and unhurried');
});
