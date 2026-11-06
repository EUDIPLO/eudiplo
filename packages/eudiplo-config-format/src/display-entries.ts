// Credential display entries (`config.display[]` of a CredentialConfig) are
// published in the issuer metadata (OID4VCI 1.0 Section 12.2.4), so their
// colors and locales follow that section (CredentialConfig v4).

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const INTEGER = String.raw`[+-]?\d+`;
const PERCENTAGE = `${NUMBER}%`;

function colorFunction(name: string, args: string[]): string {
    return String.raw`${name}\( *${args.join(" *, *")} *\)`;
}

/**
 * The numerical color values of CSS Color Module Level 3 (Section 4.2), which
 * OID4VCI 1.0 Section 12.2.4 requires for `background_color` and
 * `text_color`: `#rgb`, `#rrggbb`, `rgb()`, `rgba()`, `hsl()`, `hsla()` and
 * `transparent`. Function names are lowercase, arguments are separated by
 * commas, and `rgb()` takes three integers or three percentages. Color
 * keywords such as `navy` and newer forms such as `#rrggbbaa` or `oklch()` are
 * not numerical values. The pattern has no lookarounds or backreferences, so
 * JSON Schema validators and RE2 run it as well.
 */
export const DISPLAY_COLOR_PATTERN = `^(?:${[
    "#(?:[0-9a-fA-F]{3}){1,2}",
    colorFunction("rgb", [INTEGER, INTEGER, INTEGER]),
    colorFunction("rgb", [PERCENTAGE, PERCENTAGE, PERCENTAGE]),
    colorFunction("rgba", [INTEGER, INTEGER, INTEGER, NUMBER]),
    colorFunction("rgba", [PERCENTAGE, PERCENTAGE, PERCENTAGE, NUMBER]),
    colorFunction("hsl", [NUMBER, PERCENTAGE, PERCENTAGE]),
    colorFunction("hsla", [NUMBER, PERCENTAGE, PERCENTAGE, NUMBER]),
    "transparent",
].join("|")})$`;

const DISPLAY_COLOR = new RegExp(DISPLAY_COLOR_PATTERN);

/** Explains the accepted forms; shared by the API, the CLI and the migration. */
export const DISPLAY_COLOR_MESSAGE =
    "Use a CSS Color Level 3 numerical value: #rgb, #rrggbb, transparent, or lowercase rgb(), rgba(), hsl() or hsla() with comma-separated values, for example rgb(18, 16, 124).";

// Field descriptions shared by the API schema (JSON Schema, config files) and the
// OpenAPI entity, so the two cannot drift apart.
export const DISPLAY_NAME_DESCRIPTION = "Credential name shown by wallets.";
export const DISPLAY_LOCALE_DESCRIPTION =
    "Language tag of this entry, for example en-US. Each locale may appear once.";
export const DISPLAY_DESCRIPTION_DESCRIPTION =
    "Optional description of the credential for this locale.";
export function displayColorDescription(what: "background" | "text"): string {
    return `Optional ${what} color for card-style rendering, as a CSS Color Level 3 numerical value: #rgb, #rrggbb, transparent, or lowercase rgb(), rgba(), hsl() or hsla() with comma-separated values. Without it, wallets use their own.`;
}

/** Whether `value` is a display color wallets can read (see {@link DISPLAY_COLOR_PATTERN}). */
export function isDisplayColor(value: string): boolean {
    return DISPLAY_COLOR.test(value);
}

/** The color keys of a credential display entry. */
export const DISPLAY_COLOR_KEYS = ["background_color", "text_color"] as const;

/**
 * The color in the form wallets read, or `undefined` when it cannot be one.
 * Surrounding spaces are trimmed and function names lowercased, as CSS treats
 * them case-insensitively; keywords such as `navy` and other forms are not
 * converted.
 */
export function readableDisplayColor(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const color = value.trim();
    if (isDisplayColor(color)) return color;
    const lowercase = color.toLowerCase();
    return isDisplayColor(lowercase) ? lowercase : undefined;
}

/** A display entry whose locale an earlier entry of the same array already uses. */
export interface DuplicateDisplayLocale {
    /** Position of the duplicate entry. */
    index: number;
    /** Position of the first entry with this locale. */
    firstIndex: number;
    locale: string;
}

/**
 * Entries that repeat the locale of an earlier entry. OID4VCI 1.0 Section
 * 12.2.4: "There MUST be only one object for each language identifier."
 * Language tags are compared case-insensitively (RFC 5646 Section 2.1.1).
 */
export function findDuplicateDisplayLocales(
    display: readonly unknown[],
): DuplicateDisplayLocale[] {
    const first = new Map<string, number>();
    const duplicates: DuplicateDisplayLocale[] = [];
    display.forEach((entry, index) => {
        const locale =
            typeof entry === "object" && entry !== null
                ? (entry as { locale?: unknown }).locale
                : undefined;
        if (typeof locale !== "string" || locale === "") return;
        const key = locale.toLowerCase();
        const firstIndex = first.get(key);
        if (firstIndex === undefined) first.set(key, index);
        else duplicates.push({ index, firstIndex, locale });
    });
    return duplicates;
}

/** The message for a duplicate locale; shared by the API, the CLI and the migration. */
export function duplicateDisplayLocaleMessage(
    duplicate: DuplicateDisplayLocale,
): string {
    return `Locale ${duplicate.locale} is already used by display entry ${duplicate.firstIndex + 1}. OID4VCI allows one display entry per language.`;
}

/**
 * The entries as wallets should get them: colors in the form
 * {@link readableDisplayColor} returns, without the ones it cannot repair, and
 * only the first entry per locale. Configurations stored before
 * CredentialConfig v4 can hold other values until they are saved again; the
 * issuer metadata and exports use this instead.
 */
export function publishableDisplayEntries<T extends object>(
    display: readonly T[],
): T[] {
    const repeated = new Set(
        findDuplicateDisplayLocales(display).map(({ index }) => index),
    );
    return display
        .filter((_, index) => !repeated.has(index))
        .map((entry) => {
            let copy: Record<string, unknown> | undefined;
            for (const key of DISPLAY_COLOR_KEYS) {
                const value = (entry as Record<string, unknown>)[key];
                if (value === undefined) continue;
                const color = readableDisplayColor(value);
                if (color === value) continue;
                copy ??= { ...entry } as Record<string, unknown>;
                if (color === undefined) delete copy[key];
                else copy[key] = color;
            }
            return (copy ?? entry) as T;
        });
}
