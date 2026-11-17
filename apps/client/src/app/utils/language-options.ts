/** A language a display or purpose text can be written in. */
export interface LanguageOption {
  value: string;
  label: string;
}

/**
 * The 24 official EU languages, offered for display names and registration
 * certificate purposes as language-only tags (BCP 47, ISO 639-1): EUDIPLO has
 * no regional variants of a text, and wallets match a language tag such as
 * `de` for any `de-*` user setting.
 */
export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'German' },
  { value: 'bg', label: 'Bulgarian' },
  { value: 'hr', label: 'Croatian' },
  { value: 'cs', label: 'Czech' },
  { value: 'da', label: 'Danish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'et', label: 'Estonian' },
  { value: 'fi', label: 'Finnish' },
  { value: 'fr', label: 'French' },
  { value: 'el', label: 'Greek' },
  { value: 'hu', label: 'Hungarian' },
  { value: 'ga', label: 'Irish' },
  { value: 'it', label: 'Italian' },
  { value: 'lv', label: 'Latvian' },
  { value: 'lt', label: 'Lithuanian' },
  { value: 'mt', label: 'Maltese' },
  { value: 'pl', label: 'Polish' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ro', label: 'Romanian' },
  { value: 'sk', label: 'Slovak' },
  { value: 'sl', label: 'Slovenian' },
  { value: 'es', label: 'Spanish' },
  { value: 'sv', label: 'Swedish' },
];

/** The language of a new text. */
export const DEFAULT_LANGUAGE = 'en';

/**
 * The language of a tag, lowercased: `de` for `de`, `DE` and `de-DE`. Texts
 * with the same language count as one language, since EUDIPLO keeps no
 * regional variants.
 */
export function languageOf(tag: unknown): string {
  return typeof tag === 'string' ? (tag.split('-')[0] ?? '').toLowerCase() : '';
}

let displayNames: Intl.DisplayNames | undefined;

/** "German (de-DE)" for a tag that is not in the list, else the tag itself. */
function labelOf(tag: string): string {
  try {
    displayNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
    const name = displayNames.of(languageOf(tag));
    return name && name.toLowerCase() !== languageOf(tag) ? `${name} (${tag})` : tag;
  } catch {
    return tag;
  }
}

/**
 * The options plus `current` when a stored configuration uses a tag the list
 * lacks, such as `de-DE`, so editing it shows and keeps that tag.
 */
export function languageOptionsWith(current: unknown): readonly LanguageOption[] {
  return typeof current === 'string' &&
    current !== '' &&
    // A select matches its options exactly, so `EN` needs an option of its own.
    !LANGUAGE_OPTIONS.some((option) => option.value === current)
    ? [...LANGUAGE_OPTIONS, { value: current, label: labelOf(current) }]
    : LANGUAGE_OPTIONS;
}

/** The first listed language none of `used` has, whatever their region. */
export function firstUnusedLanguage(used: readonly unknown[]): string | undefined {
  const languages = new Set(used.map(languageOf));
  return LANGUAGE_OPTIONS.find((option) => !languages.has(option.value))?.value;
}
