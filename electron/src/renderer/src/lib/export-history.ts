import { apiJson, errorFromResponse } from '@/lib/api/client';
import { saveLocalFile } from '@/lib/local-export';
import { saveBackendFile } from '@/lib/native-save';
import { queryClient } from '@/lib/query';

const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'm4b', 'mp3', 'ogg', 'opus', 'wav']);
const VIDEO_EXTENSIONS = new Set(['mkv', 'mov', 'mp4', 'webm']);

function exportMode(filename: string): 'audio' | 'video' | 'file' {
  const extension = filename.split('.').pop()?.toLocaleLowerCase() || '';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return 'file';
}

/**
 * Save through Electron's trusted main process, then mirror the successful
 * native save into the backend's shared export history. History recording is
 * deliberately non-fatal: a bookkeeping outage must not turn a written file
 * into a failed export.
 *
 * In a plain browser tab there is no main process to write through, so the
 * backend URL is fetched and handed to the browser's own download — the same
 * fallback `saveLocalFile` uses. Without it every export control would be dead
 * in the web build (#3923).
 */
export async function saveExport(
  url: string,
  suggestedName: string,
  options: { quiet?: boolean } = {},
) {
  const saved =
    (await saveBackendFile({ url, suggestedName, quiet: options.quiet })) ??
    (await saveBrowserDownload(url, suggestedName));
  if (!saved) return null;
  if (!saved.canceled && saved.path && saved.native) {
    try {
      await apiJson('/export/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: saved.path.split(/[\\/]/).pop() || suggestedName,
          destination_path: saved.path,
          mode: exportMode(saved.path),
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['export-history'] });
    } catch (error) {
      console.warn('Could not record the completed export', error);
    }
  }
  return saved;
}

/**
 * Browser-tab fallback: fetch the backend URL and save the bytes locally. The
 * browser owns the destination, so there is no path to record in history.
 *
 * `saved.path` is the download's name rather than a real filesystem path: the
 * browser hands the file to the user's download folder and never tells the page
 * where it landed. Without a name here the caller has nothing to confirm, and
 * Save as finished in total silence (#3923).
 */
async function saveBrowserDownload(url: string, suggestedName: string) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw await errorFromResponse(res);
  const saved = await saveLocalFile(await res.blob(), suggestedName);
  // `native: false` keeps the download's name out of the export history, which
  // stores real destination paths.
  return { canceled: saved.canceled, path: saved.canceled ? '' : suggestedName, native: false };
}
