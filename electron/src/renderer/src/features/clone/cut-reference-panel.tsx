import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScissorsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useTrimProfileAudio } from '@/hooks/use-profile-reference-tools';
import { describeError } from '@/lib/api/client';
import type { Profile } from '@/lib/api/types';

/** Shortest window worth keeping: below this a clone has nothing to copy. */
export const MIN_CUT_SECONDS = 0.5;

export interface CutReferencePanelProps {
  profile: Profile;
  /** Length of the stored clip, when the page already knows it. */
  durationSeconds: number | null;
  disabled?: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Permanently cut a reference clip down to one window (#3925).
 *
 * Engines pick their own best few seconds of a long clip, so a reference that
 * contains a chorus, a second speaker or a long silence clones the wrong
 * passage. Trimming the file is the only way to decide what they hear — a
 * playback-only range would leave the stored clip untouched.
 */
export function CutReferencePanel({
  profile,
  durationSeconds,
  disabled,
}: CutReferencePanelProps) {
  const { t } = useTranslation();
  const prefix = useId();
  const trim = useTrimProfileAudio();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const total = durationSeconds && durationSeconds > 0 ? durationSeconds : null;
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(total ?? 0);
  const [keepTranscript, setKeepTranscript] = useState(false);

  // A replaced clip has a different length, so the window must be re-seeded
  // rather than kept as-is: a stale end would cut past the new audio.
  useEffect(() => {
    setStart(0);
    setEnd(total ?? 0);
  }, [total, profile.audio_url]);

  const width = end - start;
  const tooShort = total != null && width < MIN_CUT_SECONDS;
  const whole = total != null && start === 0 && end === total;

  const apply = async () => {
    setFailed(null);
    try {
      await trim.mutateAsync({
        id: profile.id,
        startS: start,
        endS: end,
        keepTranscript,
      });
      setOpen(false);
    } catch (error) {
      setFailed(describeError(error));
    }
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={disabled || total == null}
        onClick={() => setOpen(true)}
      >
        <ScissorsIcon data-icon="inline-start" />
        {t('clone.cut_reference')}
      </Button>
    );
  }

  return (
    <div
      data-cut-reference
      className="flex flex-col gap-3 rounded-lg border border-border/60 bg-background/60 p-3 @min-[620px]:col-span-2"
    >
      <p role="note" className="text-xs text-muted-foreground">
        {t('clone.cut_reference_hint')}
      </p>
      <div className="grid gap-3 @min-[420px]:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-start`}>{t('clone.cut_start')}</Label>
          <input
            id={`${prefix}-start`}
            type="range"
            min={0}
            max={total ?? 0}
            step={0.1}
            value={start}
            disabled={trim.isPending}
            aria-valuetext={t('clone.cut_seconds', { seconds: start.toFixed(1) })}
            onChange={(event) => {
              const next = Number(event.target.value);
              setStart(clamp(next, 0, Math.max(0, end - MIN_CUT_SECONDS)));
            }}
            className="w-full"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-end`}>{t('clone.cut_end')}</Label>
          <input
            id={`${prefix}-end`}
            type="range"
            min={0}
            max={total ?? 0}
            step={0.1}
            value={end}
            disabled={trim.isPending}
            aria-valuetext={t('clone.cut_seconds', { seconds: end.toFixed(1) })}
            onChange={(event) => {
              const next = Number(event.target.value);
              setEnd(clamp(next, start + MIN_CUT_SECONDS, total ?? 0));
            }}
            className="w-full"
          />
        </div>
      </div>
      <p className="text-xs tabular-nums text-muted-foreground">
        {t('clone.cut_keeps', { seconds: width.toFixed(1) })}
      </p>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={keepTranscript}
          disabled={trim.isPending}
          onChange={(event) => setKeepTranscript(event.target.checked)}
        />
        {t('clone.cut_keep_transcript')}
      </label>
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          {failed}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={trim.isPending || tooShort || whole}
          onClick={() => void apply()}
        >
          {t('clone.cut_apply')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={trim.isPending}
          onClick={() => setOpen(false)}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
