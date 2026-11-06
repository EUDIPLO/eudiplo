import { AbstractControl, FormArray, ValidationErrors } from '@angular/forms';
import { credentialConfigSchema } from './schemas';

// The API's pattern (DISPLAY_COLOR_PATTERN in @eudiplo/config-format), read from the
// committed schema so the form accepts exactly what the API accepts: the CSS Color Level 3
// numerical values that OID4VCI 1.0 Section 12.2.4 requires for display colors.
const DISPLAY_COLOR = new RegExp(
  credentialConfigSchema.getSchema().properties.config.properties.display.items.properties
    .background_color.pattern
);

/**
 * The color as the API publishes it to wallets, or undefined (readableDisplayColor in
 * @eudiplo/config-format): trimmed, function names lowercased, anything else dropped.
 */
function readableDisplayColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const color = value.trim();
  if (DISPLAY_COLOR.test(color)) return color;
  return DISPLAY_COLOR.test(color.toLowerCase()) ? color.toLowerCase() : undefined;
}

/**
 * The display entries as the issuer metadata publishes them (publishableDisplayEntries in
 * @eudiplo/config-format): only the first entry per locale, compared case-insensitively, and
 * only colors wallets can read. Configurations saved before these checks can hold more.
 */
export function walletDisplayEntries<T extends Record<string, any>>(display: readonly T[]): T[] {
  const seen = new Set<string>();
  return display
    .filter((entry) => {
      const locale = typeof entry['locale'] === 'string' ? entry['locale'].toLowerCase() : '';
      if (!locale) return true;
      if (seen.has(locale)) return false;
      seen.add(locale);
      return true;
    })
    .map((entry) => {
      const copy: Record<string, any> = { ...entry };
      for (const key of ['background_color', 'text_color']) {
        if (copy[key] === undefined) continue;
        const color = readableDisplayColor(copy[key]);
        if (color === undefined) delete copy[key];
        else copy[key] = color;
      }
      return copy as T;
    });
}

/** Refuses a display color wallets cannot read; empty means the wallet's own color. */
export function displayColorValidator(control: AbstractControl): ValidationErrors | null {
  const color = typeof control.value === 'string' ? control.value.trim() : '';
  return !color || DISPLAY_COLOR.test(color) ? null : { displayColor: true };
}

/**
 * On the locale control of a display entry in a FormArray: refuses a locale that an earlier
 * entry already uses, compared case-insensitively as the API does. OID4VCI 1.0 Section 12.2.4
 * allows one display entry per language. Siblings do not revalidate on their own, so the form
 * calls `updateValueAndValidity` on every locale control when the entries change.
 */
export function uniqueDisplayLocaleValidator(control: AbstractControl): ValidationErrors | null {
  const entry = control.parent;
  const entries = entry?.parent;
  const locale = typeof control.value === 'string' ? control.value.toLowerCase() : '';
  if (!entry || !(entries instanceof FormArray) || !locale) return null;
  const index = entries.controls.indexOf(entry);
  const firstIndex = entries.controls.findIndex(
    (other) => String(other.get('locale')?.value ?? '').toLowerCase() === locale
  );
  return firstIndex < index ? { duplicateLocale: { firstIndex } } : null;
}
