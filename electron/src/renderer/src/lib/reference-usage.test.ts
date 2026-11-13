import { describe, expect, it } from 'vitest';
import { engineTrimsReference, recommendedRefRange, referenceUsageNote } from './reference-usage';

const omnivoice = { id: 'omnivoice', max_ref_seconds: 20, ref_strategy: 'best_window' } as const;
const voxcpm = { id: 'voxcpm2', max_ref_seconds: 30, ref_strategy: 'head' } as const;
const unverified = { id: 'other', max_ref_seconds: null, ref_strategy: null };

describe('recommendedRefRange', () => {
  it('narrows the recommendation for an engine that documents its own', () => {
    expect(recommendedRefRange(omnivoice)).toEqual([3, 10]);
  });

  it('falls back to the shared recommendation for anything else', () => {
    expect(recommendedRefRange(voxcpm)).toEqual([5, 15]);
    expect(recommendedRefRange(null)).toEqual([5, 15]);
    expect(recommendedRefRange(undefined)).toEqual([5, 15]);
  });
});

describe('referenceUsageNote', () => {
  it('stays quiet inside the recommendation', () => {
    expect(referenceUsageNote(omnivoice, 5)).toBeNull();
    expect(referenceUsageNote(omnivoice, 10)).toBeNull();
    expect(referenceUsageNote(voxcpm, 12)).toBeNull();
    expect(referenceUsageNote(omnivoice, null)).toBeNull();
  });

  it('names the floor a clip falls under', () => {
    expect(referenceUsageNote(omnivoice, 2)).toEqual({ kind: 'short', seconds: 3 });
    expect(referenceUsageNote(voxcpm, 4)).toEqual({ kind: 'short', seconds: 5 });
  });

  it('names the passage an OmniVoice-style engine picks from a long clip', () => {
    expect(referenceUsageNote(omnivoice, 25)).toEqual({
      kind: 'best_window',
      seconds: 20,
    });
  });

  it('names the head an engine keeps', () => {
    expect(referenceUsageNote(voxcpm, 45)).toEqual({ kind: 'head', seconds: 30 });
  });

  it('makes no engine claim when the clip fits or the engine is unverified', () => {
    expect(referenceUsageNote(omnivoice, 18)).toEqual({ kind: 'long', seconds: 10 });
    expect(referenceUsageNote(unverified, 60)).toEqual({ kind: 'long', seconds: 15 });
    expect(referenceUsageNote(null, 60)).toEqual({ kind: 'long', seconds: 15 });
  });
});

describe('engineTrimsReference', () => {
  it('is true only past a verified engine limit', () => {
    expect(engineTrimsReference(omnivoice, 20)).toBe(false);
    expect(engineTrimsReference(omnivoice, 20.5)).toBe(true);
    expect(engineTrimsReference(voxcpm, 31)).toBe(true);
    expect(engineTrimsReference(unverified, 70)).toBe(false);
    expect(engineTrimsReference(omnivoice, null)).toBe(false);
  });
});
