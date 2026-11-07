/**
 * Split a comma-separated configuration value into its entries.
 * Whitespace around entries and empty entries are ignored.
 */
export function splitCommaSeparatedList(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}
