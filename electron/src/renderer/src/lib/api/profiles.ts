import { apiFetch, apiJson } from './client';
import { sanitizeInstruct } from './generate';
import type { Profile } from './types';

export interface CreateCloneProfileInput {
  name: string;
  seed?: number | null;
  image?: File;
  refAudio: File | Blob;
  refAudioName?: string;
  refText?: string;
  instruct?: string;
  language?: string;
}

export async function listProfiles({ signal }: { signal?: AbortSignal } = {}): Promise<Profile[]> {
  return apiJson<Profile[]>('/profiles', { signal });
}

export async function updateProfileImage(id: string, image: File): Promise<Profile> {
  const form = new FormData();
  form.append('image', image);
  return apiJson<Profile>(`/profiles/${encodeURIComponent(id)}/image`, {
    method: 'PUT',
    body: form,
  });
}

export async function createCloneProfile(input: CreateCloneProfileInput): Promise<Profile> {
  const form = new FormData();
  form.append('name', input.name);
  if (input.image) form.append('image', input.image);
  const fileName =
    input.refAudioName ||
    (input.refAudio instanceof File ? input.refAudio.name : '') ||
    'profile.wav';
  form.append('ref_audio', input.refAudio, fileName);
  form.append('ref_text', input.refText ?? '');
  // Same whitelist as /generate: a saved profile must never carry an instruct
  // the engine will reject on every later synthesis.
  form.append('instruct', input.instruct ? sanitizeInstruct(input.instruct).instruct : '');
  form.append('language', input.language || 'Auto');
  form.append('kind', 'clone');
  if (input.seed != null) form.append('seed', String(input.seed));
  return apiJson<Profile>('/profiles', { method: 'POST', body: form });
}

export interface ReplaceProfileAudioInput {
  refAudio: File | Blob;
  refAudioName?: string;
  /** Transcript of the NEW clip; blank lets the backend transcribe it locally. */
  refText?: string;
  /**
   * Profile edits saved in the same request as the clip, so a failed
   * replacement leaves the whole profile unchanged.
   */
  fields?: Partial<Pick<Profile, 'name' | 'instruct' | 'language' | 'personality'>>;
}

/**
 * Replace a saved clone's reference clip in place (#2282). The backend keeps
 * the profile id, clears its locked take and own-voice consent, and returns
 * the updated record.
 */
export async function replaceProfileAudio(
  id: string,
  input: ReplaceProfileAudioInput,
): Promise<Profile> {
  const form = new FormData();
  const fileName =
    input.refAudioName ||
    (input.refAudio instanceof File ? input.refAudio.name : '') ||
    'reference.wav';
  form.append('ref_audio', input.refAudio, fileName);
  form.append('ref_text', input.refText ?? '');
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (typeof value === 'string') form.append(key, value);
  }
  return apiJson<Profile>(`/profiles/${encodeURIComponent(id)}/audio`, {
    method: 'PUT',
    body: form,
  });
}

export async function deleteProfile(id: string): Promise<void> {
  await apiFetch(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Permanently cut a clone's reference clip down to one window (#3925).
 *
 * A cut is what fixes a clone that copies the wrong passage: engines read only
 * their own best few seconds of a long clip, so trimming the file is the only
 * way to choose what they hear.
 */
export async function trimProfileAudio(
  id: string,
  input: { startS: number; endS: number; keepTranscript?: boolean },
): Promise<Profile> {
  return apiJson<Profile>(`/profiles/${encodeURIComponent(id)}/audio/trim`, {
    method: 'POST',
    body: JSON.stringify({
      start_s: input.startS,
      end_s: input.endS,
      keep_transcript: Boolean(input.keepTranscript),
    }),
  });
}

export interface BulkTranscribeProfile {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';
  ref_text: string;
  error: string | null;
}

export interface BulkTranscribeStatus {
  status: 'idle' | 'running' | 'done' | 'cancelled';
  total: number;
  done: number;
  skipped: number;
  failed: number;
  profiles: BulkTranscribeProfile[];
}

/** Start filling a transcript for every reference clip that has none or few. */
export async function startBulkTranscribe(
  includeTranscribed = false,
): Promise<BulkTranscribeStatus & { started: boolean }> {
  return apiJson<BulkTranscribeStatus & { started: boolean }>('/profiles/transcripts/auto', {
    method: 'POST',
    body: JSON.stringify({ include_transcribed: includeTranscribed }),
  });
}

export async function bulkTranscribeStatus({
  signal,
}: { signal?: AbortSignal } = {}): Promise<BulkTranscribeStatus> {
  return apiJson<BulkTranscribeStatus>('/profiles/transcripts/auto', { signal });
}

export async function cancelBulkTranscribe(): Promise<
  BulkTranscribeStatus & { cancelled: boolean }
> {
  return apiJson<BulkTranscribeStatus & { cancelled: boolean }>('/profiles/transcripts/auto', {
    method: 'DELETE',
  });
}
