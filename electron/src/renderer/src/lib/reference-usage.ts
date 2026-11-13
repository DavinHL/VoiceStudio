import { CLONE_MAX_SECONDS, REF_MIN_SECONDS } from '@/lib/api/generate';
import type { EngineBackend } from '@/lib/api/types';

type EngineRefLimits = Pick<EngineBackend, 'max_ref_seconds' | 'ref_strategy'>;

/**
 * How much reference speech to record. Engines that document a narrower
 * sweet spot than the shared 5–15 s recommendation override it here; the
 * default engine (OmniVoice) wants the 3–10 s its own guide names.
 */
export const RECOMMENDED_REF_SECONDS: Readonly<Record<string, readonly [number, number]>> = {
  omnivoice: [3, 10],
};

/** The recommended reference range for `engine`, defaulting to the shared one. */
export function recommendedRefRange(
  engine: (EngineRefLimits & { id?: string | null }) | null | undefined,
): readonly [number, number] {
  const named = engine?.id ? RECOMMENDED_REF_SECONDS[engine.id] : undefined;
  return named ?? [REF_MIN_SECONDS, CLONE_MAX_SECONDS];
}

/** The engine keeps only part of this clip, and chooses that part itself (#2281). */
export function engineTrimsReference(
  engine: EngineRefLimits | null | undefined,
  durationSeconds: number | null,
): boolean {
  const max = engine?.max_ref_seconds;
  return (
    durationSeconds !== null &&
    typeof max === 'number' &&
    max > 0 &&
    durationSeconds > max &&
    (engine?.ref_strategy === 'best_window' || engine?.ref_strategy === 'head')
  );
}

/**
 * What Voice Clone should say about a reference outside the recommended
 * range: how much of a long clip the active engine really uses, or that a
 * short one gives the clone too little delivery to mirror. Returns null inside
 * the recommendation, so a good clip gets no note.
 */
export function referenceUsageNote(
  engine: (EngineRefLimits & { id?: string | null }) | null | undefined,
  durationSeconds: number | null,
): { kind: 'best_window' | 'head' | 'long' | 'short'; seconds: number } | null {
  if (durationSeconds === null) return null;
  const [min, max] = recommendedRefRange(engine);
  // A clip shorter than the floor leaves the model guessing at the delivery it
  // is supposed to mirror, so the guidance is worth more than silence here.
  if (durationSeconds < min) return { kind: 'short', seconds: min };
  if (durationSeconds <= max) return null;
  if (engineTrimsReference(engine, durationSeconds)) {
    const seconds = Math.round(engine?.max_ref_seconds ?? 0);
    return engine?.ref_strategy === 'head'
      ? { kind: 'head', seconds }
      : { kind: 'best_window', seconds };
  }
  return { kind: 'long', seconds: max };
}
