import {
  AlertCircleIcon,
  ArrowLeftRightIcon,
  BanIcon,
  CheckCircle2Icon,
  CheckIcon,
  DownloadIcon,
  InfoIcon,
  Loader2Icon,
  MicIcon,
  SquareIcon,
  Trash2Icon,
  UploadIcon,
  WandSparklesIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';

import { SecondarySidebar } from '@/components/workspace-sidebar';
import { WorkspaceHeader } from '@/components/app-shell/workspace-header';
import { ProfileAvatar } from '@/components/profile-avatar';
import { AudioPreviewButton } from '@/components/audio-preview-button';
import { PipelineFailure } from '@/components/pipeline-failure';
import { RecordingInputs } from '@/components/recording-inputs';
import { WaveformPlayer } from '@/components/waveform-player';
import { SaveAudioButton } from '@/components/save-audio-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { LanguagePicker } from '@/features/clone/language-picker';
import { CONVERT_SOURCE_LANGUAGES } from '@/features/tools/convert-languages';
import { useEngines } from '@/hooks/use-engines';
import { useProfiles } from '@/hooks/use-profiles';
import { useRecording } from '@/hooks/use-recording';
import { apiPath, describeError, profileAudioUrl } from '@/lib/api/client';
import { convertSpeech, type ConvertResult } from '@/lib/api/convert';
import { saveExport } from '@/lib/export-history';
import { toast } from 'sonner';

type ItemStatus = 'queued' | 'converting' | 'done' | 'error';

interface QueueItem {
  id: string;
  file: File;
  status: ItemStatus;
  result?: ConvertResult;
  error?: string;
}

const MEDIA_EXT = /\.(mp3|wav|m4a|flac|ogg|aac|opus|webm|mp4|mov|mkv|avi|m4v|flv|wmv)$/i;

function isMediaFile(file: File): boolean {
  return (
    file.type.startsWith('audio/') || file.type.startsWith('video/') || MEDIA_EXT.test(file.name)
  );
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Voice Changer workspace: drop audio or video clips (many at once), pick a
 * saved voice, and convert each clip into that voice. Reuses `POST /convert`,
 * so a video is decoded to its audio track by the backend and the two modes
 * match Studio's Convert: re-speak the transcript, or keep the speaker's own
 * delivery (speech-to-speech) when an installed engine supports it.
 */
export function VoiceChangerPage() {
  const { t } = useTranslation();
  const profiles = useProfiles();
  const engines = useEngines();
  const canClone = engines.activeTtsReady && engines.activeTts?.supports_cloning === true;
  const canKeepDelivery = (engines.data?.tts?.backends ?? []).some(
    (b) => b.available && b.supports_voice_conversion === true && b.routing_status !== 'unavailable',
  );

  const [items, setItems] = useState<QueueItem[]>([]);
  const [voice, setVoice] = useState('');
  const [search, setSearch] = useState('');
  const [keepDelivery, setKeepDelivery] = useState(false);
  const [match, setMatch] = useState(true);
  const [language, setLanguage] = useState('Auto');
  const [busy, setBusy] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  // The queue is read inside the sequential run loop, but its state is owned by
  // React: a `stop()` (or an unmount) must be visible to the loop on the next
  // item, otherwise the run keeps converting after the user asked it to stop.
  const stopped = useRef(false);

  const voices = (profiles.data ?? []).filter(
    (p) => p.ref_audio_path || (p.is_locked && p.locked_audio_path),
  );
  const chosen = voices.find((p) => p.id === voice);
  const ready = keepDelivery ? canKeepDelivery : canClone;
  const filteredVoices = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return voices;
    return voices.filter((p) => p.name.toLocaleLowerCase().includes(needle));
  }, [voices, search]);

  // Keep the selection valid: preselect the first voice, and drop a selection
  // that no longer exists (the profile was deleted or lost its reference while
  // this page was open) so Convert never runs against a stale id.
  useEffect(() => {
    if (voices.some((p) => p.id === voice)) return;
    setVoice(voices.length ? voices[0].id : '');
  }, [voice, voices]);

  useEffect(
    () => () => {
      stopped.current = true;
      controller.current?.abort();
    },
    [],
  );

  const addFiles = useCallback((incoming: FileList | File[] | null) => {
    const list = Array.from(incoming ?? []).filter(isMediaFile);
    if (!list.length) return;
    setError('');
    setItems((current) => [
      ...current,
      ...list.map((file) => ({
        id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 8)}`,
        file,
        status: 'queued' as ItemStatus,
      })),
    ]);
  }, []);

  // A finished take is held here first so it can be reviewed before it joins
  // the queue: recording is the one source the user cannot re-import from disk,
  // so converting it straight away hides both the mistake and the undo.
  const [take, setTake] = useState<File | null>(null);
  const [takeUrl, setTakeUrl] = useState('');
  const recording = useRecording((file) => setTake(file), false);
  // Any part of the take lifecycle blocks actions that would fight with it —
  // but NOT the record button itself, which has to stay clickable to stop.
  const recordingBusy = recording.isStarting || recording.isRecording || recording.isCleaning;

  useEffect(() => {
    const url = take ? URL.createObjectURL(take) : '';
    setTakeUrl(url);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [take]);

  const acceptTake = () => {
    if (!take) return;
    addFiles([take]);
    setTake(null);
  };

  const patch = (id: string, next: Partial<QueueItem>) =>
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...next } : item)));

  const run = async () => {
    if (busy || !chosen || !ready) return;
    const pending = items.filter((item) => item.status === 'queued' || item.status === 'error');
    if (!pending.length) return;
    setBusy(true);
    setError('');
    stopped.current = false;
    for (const item of pending) {
      if (stopped.current) break;
      const abort = new AbortController();
      controller.current = abort;
      patch(item.id, { status: 'converting', error: undefined });
      try {
        const result = await convertSpeech(
          item.file,
          chosen.id,
          match,
          abort.signal,
          language,
          keepDelivery,
        );
        patch(item.id, { status: 'done', result });
      } catch (e) {
        // An aborted take belongs back in the queue, not in the error list:
        // `describeError` on an AbortError would show a failure the user
        // caused on purpose.
        if (abort.signal.aborted) {
          patch(item.id, { status: 'queued' });
          break;
        }
        patch(item.id, { status: 'error', error: describeError(e) });
      } finally {
        if (controller.current === abort) controller.current = null;
      }
    }
    setBusy(false);
  };

  const stop = () => {
    stopped.current = true;
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
  };

  const done = items.filter((item) => item.status === 'done' && item.result);
  const pendingCount = items.filter((item) => item.status !== 'done').length;
  const convertLabel = busy
    ? t('voiceChanger.converting', { done: done.length, total: items.length })
    : t('voiceChanger.convert_all', { count: pendingCount });

  const saveAll = async () => {
    let saved = 0;
    // The per-row button already confirms each file; the bulk path must not
    // stack one toast per clip on top of its own summary.
    setBulkSaving(true);
    for (const item of done) {
      const name = `${baseName(item.file.name)}-${chosen?.name ?? 'voice'}.wav`;
      try {
        // `saveExport` resolves null when the user closes the save dialog —
        // that is a choice, not a failure, and it must not abort the rest.
        const result = await saveExport(apiPath(item.result!.audio_url), name, { quiet: true });
        if (!result) continue;
        saved += 1;
      } catch (e) {
        setBulkSaving(false);
        toast.error(describeError(e));
        return;
      }
    }
    setBulkSaving(false);
    if (saved) toast.success(t('voiceChanger.saved_all', { count: saved }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader>
        <h1 className="text-sm font-medium">{t('voiceChanger.title')}</h1>
        <span className="text-xs text-muted-foreground">
          {items.length ? t('voiceChanger.queue_count', { count: items.length }) : null}
        </span>
      </WorkspaceHeader>
      <div className="flex min-h-0 flex-1 @max-[48rem]:flex-col">
        <SecondarySidebar
          title={t('voiceChanger.title')}
          icon={ArrowLeftRightIcon}
          variant="navigation"
          className="space-y-4"
        >
          <section className="space-y-2" aria-label={t('voiceChanger.target_voice')}>
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('voiceChanger.target_voice')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {chosen
                ? t('voiceChanger.selected_voice', { name: chosen.name })
                : t('voiceChanger.pick_voice_hint')}
            </p>
            <Input
              aria-label={t('voiceChanger.pick_voice')}
              placeholder={t('voiceChanger.pick_voice')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {filteredVoices.map((p) => (
                <div
                  key={p.id}
                  className={`flex items-center gap-1 rounded-md px-1 py-0.5 ${
                    voice === p.id ? 'bg-secondary' : ''
                  }`}
                >
                  <Button
                    variant="ghost"
                    className="min-w-0 flex-1 justify-start"
                    aria-pressed={voice === p.id}
                    onClick={() => setVoice(p.id)}
                  >
                    <ProfileAvatar name={p.name} imageUrl={p.image_url} className="size-6" />
                    <span className="truncate">{p.name}</span>
                    {voice === p.id && <CheckIcon className="ms-auto size-3.5 shrink-0" />}
                  </Button>
                  {/* Hearing the voice is what makes the choice obvious; the
                      clip is the profile's own reference take. */}
                  <AudioPreviewButton
                    src={profileAudioUrl(p.id, p.audio_url)}
                    source={`voice-changer-voice-${p.id}`}
                  />
                </div>
              ))}
              {voices.length > 0 && !filteredVoices.length && (
                <p className="px-1 py-2 text-sm text-muted-foreground">
                  {t('voiceChanger.no_matches', { query: search })}
                </p>
              )}
              {!voices.length && (
                <p className="text-sm text-muted-foreground">
                  {t('voiceChanger.no_voices')}{' '}
                  <Link to="/clone" className="font-medium text-primary hover:underline">
                    {t('voiceChanger.create_voice')}
                  </Link>
                </p>
              )}
            </div>
          </section>

          <section className="space-y-3 border-t border-border pt-3">
            <label className="flex items-start gap-3 text-sm">
              <Switch
                checked={keepDelivery}
                disabled={!canKeepDelivery}
                onCheckedChange={setKeepDelivery}
              />
              <span>
                {t('voiceChanger.keep_delivery')}
                <span className="mt-1 block text-xs text-muted-foreground">
                  {canKeepDelivery
                    ? t('voiceChanger.keep_delivery_hint')
                    : t('voiceChanger.keep_delivery_unavailable')}
                </span>
              </span>
            </label>
            {!keepDelivery && (
              <>
                <div className="space-y-2 text-sm">
                  <p>{t('voiceChanger.source_language')}</p>
                  <LanguagePicker
                    value={language}
                    supportedOptions={CONVERT_SOURCE_LANGUAGES}
                    recentsScope="voice-changer-language"
                    onValueChange={setLanguage}
                  />
                </div>
                <label className="flex items-start gap-3 text-sm">
                  <Switch checked={match} onCheckedChange={setMatch} />
                  <span>
                    {t('voiceChanger.match_duration')}
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t('voiceChanger.match_duration_hint')}
                    </span>
                  </span>
                </label>
              </>
            )}
            {busy && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground" role="status">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                {t('voiceChanger.settings_locked')}
              </p>
            )}
          </section>

          {!ready && (
            <p role="status" className="text-xs text-muted-foreground">
              {keepDelivery
                ? t('voiceChanger.keep_delivery_unavailable')
                : t('voiceChanger.cloning_required')}{' '}
              <Link
                to="/settings/models/$family"
                params={{ family: 'tts' }}
                className="font-medium text-primary hover:underline"
              >
                {t('modelSettings.models')}
              </Link>
            </p>
          )}
        </SecondarySidebar>

        <main className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto w-full max-w-3xl space-y-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{t('voiceChanger.title')}</h2>
              <p className="text-sm text-muted-foreground">{t('voiceChanger.subtitle')}</p>
            </div>

            <input
              ref={input}
              type="file"
              multiple
              accept="audio/*,video/*,.mp3,.wav,.m4a,.flac,.ogg,.aac,.webm,.mp4,.mov,.mkv,.avi,.m4v"
              className="sr-only"
              aria-label={t('voiceChanger.add_files')}
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <Button
              variant="outline"
              className={`h-auto min-h-28 w-full whitespace-normal border-dashed p-6 ${
                dragOver ? 'border-primary bg-primary/5' : ''
              }`}
              disabled={recordingBusy}
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                addFiles(e.dataTransfer.files);
              }}
            >
              <UploadIcon className="size-5" />
              <span className="text-sm">
                {t('voiceChanger.drop_files')}
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {t('voiceChanger.drop_hint')}
                </span>
              </span>
            </Button>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={recording.isRecording ? 'destructive' : 'outline'}
                aria-pressed={recording.isRecording}
                // Stop must stay clickable while recording, so this excludes
                // `recordingBusy` — that flag is true *during* the take and
                // disabling on it is what made Stop a dead button.
                disabled={busy || recording.isStarting}
                onClick={() => {
                  if (recording.isRecording) recording.stop();
                  else void recording.start();
                }}
              >
                {recording.isRecording ? (
                  <SquareIcon className="fill-current" />
                ) : (
                  <MicIcon />
                )}
                {recording.isRecording ? t('clone.stop_recording') : t('voiceChanger.record')}
              </Button>
              {recording.isRecording && (
                <div
                  className="flex items-center gap-2 text-xs"
                  role="status"
                  aria-live="polite"
                >
                  <span className="tabular-nums">{Math.floor(recording.seconds)}s</span>
                  <div
                    className="h-1.5 w-32 overflow-hidden rounded-full bg-muted"
                    role="meter"
                    aria-label={t('recording.input_level')}
                    aria-valuemin={0}
                    aria-valuemax={1}
                    aria-valuenow={Number(recording.level.toFixed(3))}
                  >
                    <div
                      className="h-full rounded-full bg-success transition-[width] duration-75 motion-reduce:transition-none"
                      style={{ width: `${Math.min(100, Math.round(recording.level * 100))}%` }}
                    />
                  </div>
                </div>
              )}
              {recording.isCleaning && (
                <span role="status" className="text-xs text-muted-foreground">
                  {t('clone.cleaning')}
                </span>
              )}
              <span className="text-xs text-muted-foreground">{t('voiceChanger.record_hint')}</span>
            </div>
            <RecordingInputs rec={recording} disabled={busy || recording.isCleaning} />

            {take && (
              <section
                className="space-y-2 rounded-lg border border-border bg-card/40 p-3"
                aria-label={t('voiceChanger.take_title')}
              >
                <p className="text-sm font-medium">{t('voiceChanger.take_title')}</p>
                {takeUrl && (
                  <WaveformPlayer src={takeUrl} source="voice-changer-take" height={36} />
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="default" disabled={busy} onClick={acceptTake}>
                    <CheckCircle2Icon />
                    {t('voiceChanger.take_add')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy || recording.isStarting}
                    onClick={() => {
                      // Drop the old take before recording again: leaving it in
                      // place would show a stale waveform next to a live meter.
                      setTake(null);
                      void recording.start();
                    }}
                  >
                    <MicIcon />
                    {t('voiceChanger.take_redo')}
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setTake(null)}>
                    <Trash2Icon />
                    {t('voiceChanger.take_discard')}
                  </Button>
                </div>
              </section>
            )}

            {error && <PipelineFailure fallback={error} onDismiss={() => setError('')} />}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="default"
                disabled={!ready || busy || recordingBusy || !chosen || !pendingCount}
                onClick={() => void run()}
              >
                {busy ? <Loader2Icon className="animate-spin" /> : <WandSparklesIcon />}
                {convertLabel}
              </Button>
              {busy && (
                <Button variant="outline" onClick={stop}>
                  <BanIcon />
                  {t('voiceChanger.stop')}
                </Button>
              )}
              {done.length > 1 && (
                <Button variant="ghost" disabled={bulkSaving} onClick={() => void saveAll()}>
                  <DownloadIcon />
                  {t('voiceChanger.save_all', { count: done.length })}
                </Button>
              )}
              {items.length > 0 && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setItems([]);
                    setError('');
                  }}
                >
                  <Trash2Icon />
                  {t('voiceChanger.clear')}
                </Button>
              )}
            </div>

            {!items.length ? (
              <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                {t('voiceChanger.empty')}
              </p>
            ) : (
              <ul className="space-y-2">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-lg border border-border bg-card/40 p-3"
                    aria-label={item.file.name}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {item.status === 'done' && (
                        <CheckCircle2Icon className="size-4 text-emerald-500" />
                      )}
                      {item.status === 'converting' && (
                        <Loader2Icon className="size-4 animate-spin text-primary" />
                      )}
                      {item.status === 'error' && (
                        <AlertCircleIcon className="size-4 text-destructive" />
                      )}
                      {item.status === 'queued' && (
                        <span className="size-2 rounded-full bg-muted-foreground/50" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {item.file.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatSize(item.file.size)}
                      </span>
                      <SaveAudioButton
                        url={item.result ? apiPath(item.result.audio_url) : undefined}
                        suggestedName={`${baseName(item.file.name)}-${chosen?.name ?? 'voice'}.wav`}
                        disabledHint={t('voiceChanger.save_needs_result')}
                        iconOnly
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('voiceChanger.remove')}
                        title={t('voiceChanger.remove')}
                        disabled={busy || item.status === 'converting'}
                        onClick={() =>
                          setItems((current) => current.filter((i) => i.id !== item.id))
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    {item.status === 'converting' && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('voiceChanger.item_converting')}
                      </p>
                    )}
                    {item.result && (
                      <div className="mt-2 space-y-1">
                        <WaveformPlayer
                          src={apiPath(item.result.audio_url)}
                          source={`voice-changer-${item.id}`}
                          height={34}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('voiceChanger.item_done', {
                            seconds: item.result.duration_s.toFixed(1),
                            text: item.result.text.slice(0, 90),
                          })}
                        </p>
                      </div>
                    )}
                    {item.error && <p className="mt-1 text-xs text-destructive">{item.error}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
