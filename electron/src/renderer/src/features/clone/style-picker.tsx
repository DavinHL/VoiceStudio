import { useTranslation } from 'react-i18next';
import { CATEGORIES } from '@shared/utils/constants';
import type { EngineBackend } from '@/lib/api/types';
import { sanitizeInstruct } from '@/lib/api/generate';
import { detailLabel } from '@/features/design/detail-labels';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Whether a page renders style as a closed set of chips. `instruct_vocabulary`
 * is the engine's own declaration: 'tags' engines (OmniVoice) accept only the
 * validator's vocabulary, 'freeform' engines (CosyVoice 3, VoxCPM2) take prose.
 * A backend predating the flag is treated as tags, matching expression.ts.
 */
export function usesTagVocabulary(engine: EngineBackend | null | undefined): boolean {
  return engine?.instruct_vocabulary !== 'freeform';
}

/** Accent and dialect are exclusive at the engine, so they share one group. */
const GROUPS: Readonly<Record<string, string>> = {
  EnglishAccent: 'accent_dialect',
  ChineseDialect: 'accent_dialect',
};

/** Every tag a picker can show, in catalog order. */
const ORDER: readonly string[] = Object.values(CATEGORIES).flat();

function categoryOf(tag: string): string | null {
  for (const [category, values] of Object.entries(CATEGORIES)) {
    if (values.includes(tag)) return category;
  }
  return null;
}

/**
 * Add or remove one tag, keeping the selection to one per category (and one
 * across the accent/dialect group) so the result is always a valid instruct.
 * Picking replaces the category's previous value rather than being refused,
 * which is what a chip row should do.
 */
export function toggleTag(current: string, tag: string): string {
  const picked = new Set(
    sanitizeInstruct(current)
      .instruct.split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const category = categoryOf(tag);
  const group = category ? (GROUPS[category] ?? category) : null;
  const wasPicked = picked.has(tag);

  if (category && group) {
    for (const other of picked) {
      const otherCategory = categoryOf(other);
      if (!otherCategory) continue;
      if ((GROUPS[otherCategory] ?? otherCategory) === group) picked.delete(other);
    }
  }
  if (!wasPicked) picked.add(tag);
  return ORDER.filter((value) => picked.has(value)).join(', ');
}

/** Style chips for an engine whose instruct is a closed set of tags. */
export function StylePicker({
  engine,
  value,
  onChange,
  disabled,
}: {
  engine: EngineBackend | null | undefined;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const active = new Set(
    sanitizeInstruct(value)
      .instruct.split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  // Chinese dialect chips live under the shared "Accent or Dialect" legend.
  const groups = Object.entries(CATEGORIES).filter(([category]) => category !== 'ChineseDialect');
  const chineseDialect = CATEGORIES.ChineseDialect ?? [];
  return (
    <div className="space-y-2" data-style-picker>
      {groups.map(([category, values]) => (
        <fieldset key={category} disabled={disabled} className="space-y-1.5">
          <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
            {t(category === 'EnglishAccent' ? 'clone.cat_AccentDialect' : `clone.cat_${category}`)}
          </legend>
          <div className="flex flex-wrap gap-1">
            {[...values, ...(category === 'EnglishAccent' ? chineseDialect : [])]
              .filter((tag) => tag !== 'Auto')
              .map((tag) => (
                <Button
                  key={tag}
                  type="button"
                  size="xs"
                  variant={active.has(tag) ? 'secondary' : 'ghost'}
                  aria-pressed={active.has(tag)}
                  className="font-normal aria-pressed:font-medium"
                  onClick={() => onChange(toggleTag(value, tag))}
                >
                  {detailLabel(t, tag)}
                </Button>
              ))}
          </div>
        </fieldset>
      ))}
      <p className="text-xs text-muted-foreground">
        {t('clone.style_tags_hint', { engine: engine?.display_name ?? '' })}
      </p>
    </div>
  );
}

/** Free-text style field for engines that take prose direction. */
export function StyleField({
  id,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-[length:var(--text-label)]">
        {t('clone.style')}
      </Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
