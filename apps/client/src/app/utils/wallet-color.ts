/**
 * OID4VCI 1.0 (section 12.2.4) publishes display colors as numerical values of CSS Color
 * Module Level 3: hex, `rgb()`, `rgba()`, `hsl()` or `hsla()`. The API accepts any string, so
 * this check only warns: keywords such as `navy`, typos such as `#FFFFF` and newer forms such
 * as `oklch()` are saved, but a wallet may not read them.
 */
const WALLET_COLOR_PATTERNS = [
  /^#(?:[0-9a-f]{3}){1,2}$/i,
  // rgb(r, g, b) and rgba(r, g, b, a), as numbers or percentages
  /^rgba?\(\s*[\d.]+%?\s*(?:,\s*[\d.]+%?\s*){2,3}\)$/i,
  // hsl(h, s%, l%) and hsla(h, s%, l%, a)
  /^hsla?\(\s*-?[\d.]+\s*(?:,\s*[\d.]+%\s*){2}(?:,\s*[\d.]+\s*)?\)$/i,
  /^transparent$/i,
];

/** True for an empty value (the wallet's default) and for the color forms wallets expect. */
export function isWalletColor(value: string | null | undefined): boolean {
  const color = value?.trim();
  return !color || WALLET_COLOR_PATTERNS.some((pattern) => pattern.test(color));
}
