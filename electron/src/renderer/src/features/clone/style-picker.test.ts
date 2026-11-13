import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '@shared/utils/constants';
import { toggleTag, usesTagVocabulary } from './style-picker';

describe('usesTagVocabulary', () => {
  it('gives a tags engine the closed picker', () => {
    expect(usesTagVocabulary({ instruct_vocabulary: 'tags' } as never)).toBe(true);
  });

  it('leaves a freeform engine its own wording', () => {
    expect(usesTagVocabulary({ instruct_vocabulary: 'freeform' } as never)).toBe(false);
  });

  it('treats a backend that predates the flag as tags, like expressionCaps does', () => {
    expect(usesTagVocabulary({} as never)).toBe(true);
    expect(usesTagVocabulary(null)).toBe(true);
    expect(usesTagVocabulary(undefined)).toBe(true);
  });
});

describe('toggleTag', () => {
  it('adds the first tag to an empty field', () => {
    expect(toggleTag('', 'male')).toBe('male');
  });

  it('removes a tag that is already picked', () => {
    expect(toggleTag('male, whisper', 'whisper')).toBe('male');
  });

  it('replaces within a category instead of stacking a second value', () => {
    // The engine accepts one attribute per category; picking is a replacement.
    expect(toggleTag('male', 'female')).toBe('female');
    expect(toggleTag('low pitch', 'very high pitch')).toBe('very high pitch');
  });

  it('replaces across the shared accent/dialect group', () => {
    // The catalog ships dialect chips as their CJK tokens; the romanized name
    // is only the label id (`CHINESE_DIALECT_IDS`), never the stored value.
    const sichuan = CATEGORIES.ChineseDialect[2];
    expect(toggleTag('british accent', sichuan)).toBe(sichuan);
    expect(toggleTag(sichuan, 'american accent')).toBe('american accent');
  });

  it('keeps tags from different categories together', () => {
    expect(toggleTag('male, whisper', 'elderly')).toBe('male, elderly, whisper');
  });

  it('normalises prose left in the field from before the picker existed', () => {
    // A stored "confident narrator" must not survive into the request, and it
    // must not block the chip the user then clicks.
    expect(toggleTag('confident narrator', 'male')).toBe('male');
  });
});
