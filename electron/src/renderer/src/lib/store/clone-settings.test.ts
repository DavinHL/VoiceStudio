import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'voicestudio.clone.settings.v1';

async function loadModule(): Promise<typeof import('./clone-settings')> {
  vi.resetModules();
  return import('./clone-settings');
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('parsePersistedCloneSettings', () => {
  it('restores valid quality choices and discards invalid persisted enums', async () => {
    const { parsePersistedCloneSettings } = await loadModule();
    expect(parsePersistedCloneSettings('{"wavBits":32,"effectPreset":"raw"}')).toMatchObject({
      wavBits: 32,
      effectPreset: 'raw',
    });
    expect(parsePersistedCloneSettings('{"wavBits":64,"effectPreset":"unknown"}')).toMatchObject({
      wavBits: 16,
      effectPreset: 'broadcast',
    });
  });
  it('restores only valid eight-weight emotion recipes and bounded strength', async () => {
    const { parsePersistedCloneSettings, DEFAULT_CLONE_SETTINGS } = await loadModule();
    const vector = [0, 0.2, 0.4, 0, 0, 0.1, 0, 0];
    expect(
      parsePersistedCloneSettings(
        JSON.stringify({
          emotionMode: 'vector',
          emotionVector: vector,
          emotionAlpha: 0.5,
        }),
      ),
    ).toMatchObject({ emotionMode: 'vector', emotionVector: vector, emotionAlpha: 0.5 });
    expect(
      parsePersistedCloneSettings(
        JSON.stringify({
          emotionMode: 'wrong',
          emotionVector: [3, 0],
          emotionAlpha: 1,
          emotionText: 'x'.repeat(501),
        }),
      ),
    ).toMatchObject({
      emotionMode: DEFAULT_CLONE_SETTINGS.emotionMode,
      emotionVector: DEFAULT_CLONE_SETTINGS.emotionVector,
      emotionAlpha: DEFAULT_CLONE_SETTINGS.emotionAlpha,
      emotionText: DEFAULT_CLONE_SETTINGS.emotionText,
    });
  });

  it('returns defaults for null, malformed JSON and non-objects', async () => {
    const { parsePersistedCloneSettings, DEFAULT_CLONE_SETTINGS } = await loadModule();
    expect(parsePersistedCloneSettings(null)).toEqual(DEFAULT_CLONE_SETTINGS);
    expect(parsePersistedCloneSettings('{not json')).toEqual(DEFAULT_CLONE_SETTINGS);
    expect(parsePersistedCloneSettings('[1,2]')).toEqual(DEFAULT_CLONE_SETTINGS);
    expect(parsePersistedCloneSettings('"str"')).toEqual(DEFAULT_CLONE_SETTINGS);
  });

  it('merges known fields and ignores unknown or mistyped ones', async () => {
    const { parsePersistedCloneSettings, DEFAULT_CLONE_SETTINGS } = await loadModule();
    const parsed = parsePersistedCloneSettings(
      JSON.stringify({
        text: 'hello',
        steps: 8,
        cfg: 'not a number',
        speed: Number.NaN,
        selectedProfileId: 'p1',
        autoPlay: 'yes',
        bogus: 1,
      }),
    );
    expect(parsed).toEqual({
      ...DEFAULT_CLONE_SETTINGS,
      text: 'hello',
      steps: 8,
      selectedProfileId: 'p1',
    });
    expect('bogus' in parsed).toBe(false);
  });
});

describe('migrateCloneSettings', () => {
  it('raises a stored class temperature the old build shipped as its factory value', async () => {
    const { migrateCloneSettings, DEFAULT_CLONE_SETTINGS, parsePersistedCloneSettings } =
      await loadModule();
    const stored = parsePersistedCloneSettings(JSON.stringify({ classTemp: 0, steps: 32 }));
    expect(migrateCloneSettings(stored)).toMatchObject({
      classTemp: DEFAULT_CLONE_SETTINGS.classTemp,
      steps: 32,
    });
  });

  it('keeps every other stored choice exactly as it was', async () => {
    const { migrateCloneSettings, parsePersistedCloneSettings } = await loadModule();
    const stored = parsePersistedCloneSettings(
      JSON.stringify({
        classTemp: 0,
        posTemp: 2.5,
        cfg: 3.4,
        speed: 1.8,
        steps: 48,
        effectPreset: 'raw',
        seed: 99,
      }),
    );
    expect(migrateCloneSettings(stored)).toMatchObject({
      posTemp: 2.5,
      cfg: 3.4,
      speed: 1.8,
      steps: 48,
      effectPreset: 'raw',
      seed: 99,
    });
  });

  it('leaves a deliberately non-zero class temperature alone', async () => {
    const { migrateCloneSettings, parsePersistedCloneSettings } = await loadModule();
    const stored = parsePersistedCloneSettings(JSON.stringify({ classTemp: 0.4 }));
    expect(migrateCloneSettings(stored).classTemp).toBe(0.4);
  });

  it('migrates the value the store hydrates from localStorage', async () => {
    localStorage.setItem(KEY, JSON.stringify({ classTemp: 0, language: 'French' }));
    const { cloneSettingsStore, DEFAULT_CLONE_SETTINGS } = await loadModule();
    expect(cloneSettingsStore.state.classTemp).toBe(DEFAULT_CLONE_SETTINGS.classTemp);
    expect(cloneSettingsStore.state.language).toBe('French');
  });
});

describe('cloneSettingsStore persistence', () => {
  it('hydrates from localStorage on module init', async () => {
    localStorage.setItem(KEY, JSON.stringify({ language: 'French', showOverrides: true }));
    const { cloneSettingsStore } = await loadModule();
    expect(cloneSettingsStore.state.language).toBe('French');
    expect(cloneSettingsStore.state.showOverrides).toBe(true);
    expect(cloneSettingsStore.state.steps).toBe(16);
  });

  it('survives malformed stored JSON', async () => {
    localStorage.setItem(KEY, '{{{');
    const { cloneSettingsStore, DEFAULT_CLONE_SETTINGS } = await loadModule();
    expect(cloneSettingsStore.state).toEqual(DEFAULT_CLONE_SETTINGS);
  });

  it('writes changes back, debounced', async () => {
    const { setCloneSetting, patchCloneSettings } = await loadModule();
    setCloneSetting('text', 'a');
    patchCloneSettings({ text: 'ab', speed: 1.2 });
    expect(localStorage.getItem(KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    expect(stored.text).toBe('ab');
    expect(stored.speed).toBe(1.2);
  });

  it('resetOverrides restores only the production overrides', async () => {
    const { cloneSettingsStore, patchCloneSettings, resetOverrides, DEFAULT_CLONE_SETTINGS } =
      await loadModule();
    patchCloneSettings({ text: 'keep me', steps: 4, duration: '2', denoise: false });
    resetOverrides();
    expect(cloneSettingsStore.state.text).toBe('keep me');
    expect(cloneSettingsStore.state.steps).toBe(DEFAULT_CLONE_SETTINGS.steps);
    expect(cloneSettingsStore.state.duration).toBe('');
    expect(cloneSettingsStore.state.denoise).toBe(true);
  });

  it('resets voice controls without changing audio quality or the draft', async () => {
    const { cloneSettingsStore, patchCloneSettings, resetVoiceControls, DEFAULT_CLONE_SETTINGS } =
      await loadModule();
    const preserved = {
      text: 'Keep script',
      refText: 'Keep transcript',
      instruct: 'Keep style',
      language: 'French',
      selectedProfileId: 'voice-123',
      showOverrides: true,
      autoPlay: true,
      wavBits: 32 as const,
      effectPreset: 'raw' as const,
      steps: 64,
    };
    patchCloneSettings({
      ...preserved,
      cfg: 4,
      speed: 1.5,
      tShift: 0.9,
      posTemp: 1,
      classTemp: 2,
      layerPenalty: 1,
      duration: '5',
      denoise: false,
      postprocess: false,
    });
    resetVoiceControls();
    expect(cloneSettingsStore.state).toEqual({ ...DEFAULT_CLONE_SETTINGS, ...preserved });
    await vi.advanceTimersByTimeAsync(300);
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).toEqual(cloneSettingsStore.state);
  });

  it('setCloneSetting is a no-op for an unchanged value', async () => {
    const { cloneSettingsStore, setCloneSetting } = await loadModule();
    const before = cloneSettingsStore.state;
    setCloneSetting('steps', before.steps);
    expect(cloneSettingsStore.state).toBe(before);
  });
});
