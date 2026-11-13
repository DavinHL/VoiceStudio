import { useTranslation } from 'react-i18next';
import { LoaderIcon, SparklesIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  useBulkTranscribeStatus,
  useCancelBulkTranscribe,
  useStartBulkTranscribe,
} from '@/hooks/use-profile-reference-tools';
import { useTtsReadiness } from '@/hooks/use-tts-readiness';

/**
 * Fill the transcript of every reference clip that has none (#3925).
 *
 * A transcript is what keeps each render from transcribing its reference clip
 * again, and it anchors a clone's prosody, so a library of untranscribed
 * voices is both slow and less faithful. Filling them one at a time by hand is
 * the part users skip, so this runs the whole library as one background job.
 */
export function BulkTranscribeButton() {
  const { t } = useTranslation();
  const status = useBulkTranscribeStatus();
  const start = useStartBulkTranscribe();
  const cancel = useCancelBulkTranscribe();
  const ttsBlocker = useTtsReadiness();
  const running = status.status === 'running';
  const remaining = status.total - status.done - status.skipped - status.failed;

  if (running) {
    return (
      <div className="flex items-center gap-2">
        <span
          role="status"
          className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
        >
          <LoaderIcon className="size-3 animate-spin" />
          {t('clone.transcribe_progress', { done: status.done, total: status.total })}
          {remaining > 0 ? (
            <span className="text-muted-foreground/70">
              {t('clone.transcribe_remaining', { count: remaining })}
            </span>
          ) : null}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          <XIcon />
          <span className="hidden sm:inline">{t('common.cancel')}</span>
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="secondary"
      title={ttsBlocker ? t('engines.none_ready_title') : undefined}
      disabled={start.isPending}
      onClick={() => start.mutate(false)}
    >
      <SparklesIcon />
      <span className="hidden sm:inline">{t('clone.transcribe_missing')}</span>
    </Button>
  );
}
