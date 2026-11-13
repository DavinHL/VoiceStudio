import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  bulkTranscribeStatus,
  cancelBulkTranscribe,
  startBulkTranscribe,
  transcribeProfileReference,
  trimProfileAudio,
  type BulkTranscribeStatus,
} from '@/lib/api/profiles';
import { describeError } from '@/lib/api/client';
import type { Profile } from '@/lib/api/types';
import { tr } from '@/lib/i18n-text';
import { queryKeys } from '@/lib/query';

/**
 * Cut a saved clone's reference clip down to one window (#3925).
 *
 * The profile record changes (new filename, cleared lock and consent), so the
 * caller gets the updated profile exactly like a reference replacement does.
 */
export function useTrimProfileAudio() {
  const queryClient = useQueryClient();
  return useMutation<
    Profile,
    Error,
    { id: string; startS: number; endS: number; keepTranscript?: boolean }
  >({
    mutationFn: ({ id, ...input }) => trimProfileAudio(id, input),
    onSuccess: async (updated) => {
      queryClient.setQueryData<Profile[]>(queryKeys.profiles, (old) =>
        old?.map((profile) => (profile.id === updated.id ? updated : profile)),
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.profiles });
    },
  });
}

/**
 * Progress of the library-wide transcript fill (#3925).
 *
 * Polling stops as soon as the run leaves `running`: a finished job only
 * changes when a new one starts, and a run costs an ASR pass per clip.
 */
export function useBulkTranscribeStatus(): BulkTranscribeStatus {
  const { data } = useQuery({
    queryKey: queryKeys.bulkTranscribe,
    queryFn: ({ signal }) => bulkTranscribeStatus({ signal }),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
  });
  return data ?? { status: 'idle', total: 0, done: 0, skipped: 0, failed: 0, profiles: [] };
}

export function useStartBulkTranscribe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (includeTranscribed: boolean) => startBulkTranscribe(includeTranscribed),
    onSuccess: async (result) => {
      queryClient.setQueryData(queryKeys.bulkTranscribe, result);
      // A second press reports the run already in flight rather than starting
      // a competing pass over the same clips.
      if (!result.started) toast.info(tr('clone.transcribe_already_running'));
      await queryClient.invalidateQueries({ queryKey: queryKeys.profiles });
    },
    onError: (error) => {
      toast.error(tr('clone.transcribe_failed', { message: describeError(error) }));
    },
  });
}

export function useCancelBulkTranscribe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: cancelBulkTranscribe,
    onSuccess: async (result) => {
      queryClient.setQueryData(queryKeys.bulkTranscribe, result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.profiles });
    },
  });
}

/**
 * Transcribe the reference clip of one profile (#3925).
 *
 * The editor calls this after a cut, which clears the transcript because the
 * old text describes audio that no longer exists. One clip, one ASR pass —
 * the library-wide run would re-read every other saved voice too.
 */
export function useTranscribeProfileReference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transcribeProfileReference(id),
    onSuccess: async () => {
      // Refresh the list so the library shows the transcript the route stored.
      // The text itself travels back to the caller, which fills the open
      // editor's own field from it without waiting for the refetch.
      await queryClient.invalidateQueries({ queryKey: queryKeys.profiles });
    },
    onError: (error) => {
      toast.error(tr('clone.transcribe_failed', { message: describeError(error) }));
    },
  });
}
