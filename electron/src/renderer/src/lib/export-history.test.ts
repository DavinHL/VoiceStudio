import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveBackendFile: vi.fn(async (): Promise<{ canceled: boolean; path: string } | null> => null),
  saveLocalFile: vi.fn(async (_blob: Blob, _name: string) => ({ canceled: false })),
  apiJson: vi.fn(async () => ({})),
}));

vi.mock('@/lib/native-save', () => ({ saveBackendFile: mocks.saveBackendFile }));
vi.mock('@/lib/local-export', () => ({ saveLocalFile: mocks.saveLocalFile }));
vi.mock('@/lib/api/client', () => ({
  apiJson: mocks.apiJson,
  errorFromResponse: async (res: Response) => new Error(`HTTP ${res.status}`),
}));
vi.mock('@/lib/query', () => ({ queryClient: { invalidateQueries: vi.fn() } }));

import { saveExport } from './export-history';

function stubFetch(blob = new Blob(['audio']), ok = true, status = 200) {
  const fetchMock = vi.fn(
    async () => ({ ok, status, statusText: '', blob: async () => blob }) as unknown as Response,
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('downloads through the browser when the desktop bridge is absent', async () => {
  const fetchMock = stubFetch();
  const result = await saveExport('/audio/ab12cd34.wav', 'take.wav');

  expect(fetchMock).toHaveBeenCalledWith('/audio/ab12cd34.wav', { credentials: 'include' });
  expect(mocks.saveLocalFile).toHaveBeenCalledOnce();
  expect(mocks.saveLocalFile.mock.calls[0][1]).toBe('take.wav');
  expect(result).toMatchObject({ canceled: false });
  // The browser owns the destination, so there is no path to record.
  expect(mocks.apiJson).not.toHaveBeenCalled();
});

it('still prefers the native main-process save when a bridge exists', async () => {
  stubFetch();
  mocks.saveBackendFile.mockResolvedValueOnce({ canceled: false, path: 'C:\\take.wav' });

  const result = await saveExport('/audio/ab12cd34.wav', 'take.wav');

  expect(result).toMatchObject({ path: 'C:\\take.wav' });
  expect(mocks.saveLocalFile).not.toHaveBeenCalled();
  expect(mocks.apiJson).toHaveBeenCalledWith('/export/record', expect.anything());
});

it('surfaces a backend failure instead of silently succeeding', async () => {
  stubFetch(new Blob([]), false, 404);
  await expect(saveExport('/audio/missing.wav', 'take.wav')).rejects.toThrow('HTTP 404');
  expect(mocks.saveLocalFile).not.toHaveBeenCalled();
});
