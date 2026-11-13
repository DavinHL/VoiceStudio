import { useTranslation } from 'react-i18next';
import { LoaderIcon, SparklesIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranscribeProfileReference } from '@/hooks/use-profile-reference-tools';
import type { Profile } from '@/lib/api/types';

export interface TranscribeReferenceButtonProps {
  profile: Profile;
  /** Apply the transcript the run produced to the editor's draft. */
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

/**
 * Transcribe this profile's reference clip and fill the transcript (#3925).
 *
 * The cut tool lives beside the clip it rewrites, but a cut clears the
 * transcript — the old text describes audio that no longer exists — so the
 * one action that follows a cut was a page away, in Saved voices. This keeps
 * the pair together: cut, then read what the clip now says.
 *
 * It transcribes this profile alone rather than the library, because the
 * editor is open on one voice and a whole-library pass would cost an ASR run
 * per saved clip.
 */
export function TranscribeReferenceButton({
  profile,
  onTranscript,
  disabled,
}: TranscribeReferenceButtonProps) {
  const { t } = useTranslation();
  const transcribe = useTranscribeProfileReference();
  const hasClip = Boolean(profile.ref_audio_path);

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={disabled || !hasClip || transcribe.isPending}
      title={hasClip ? undefined : t('clone.transcribe_needs_reference')}
      onClick={() => {
        void transcribe
          .mutateAsync(profile.id)
          .then((result) => {
            // A blank transcript means the clip held no speech; leave whatever
            // the user already typed alone rather than wiping the field.
            if (result.ref_text) onTranscript(result.ref_text);
          })
          .catch(() => {
            // The hook already reported the failure; nothing further to do.
          });
      }}
    >
      {transcribe.isPending ? (
        <LoaderIcon data-icon="inline-start" className="animate-spin" />
      ) : (
        <SparklesIcon data-icon="inline-start" />
      )}
      {t('clone.transcribe_this')}
    </Button>
  );
}
