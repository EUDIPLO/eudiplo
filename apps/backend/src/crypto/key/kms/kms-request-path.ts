/**
 * The settings of a provider that are appended to its `baseUrl` to build the
 * request URLs, as paths relative to the provider.
 */
export function kmsRequestPathFields(provider: { type: string }): string[] {
    if (provider.type === "http") return ["keysPath", "healthPath"];
    if (provider.type === "csc") return ["apiPath"];
    return [];
}

/**
 * Whether `path`, appended to `baseUrl`, makes a request go to another
 * server than `baseUrl` names, as `@other.example/keys` or
 * `.other.example/keys` would. The provider's credentials and client
 * certificate are bound to `baseUrl`, so such a path would send them
 * elsewhere.
 */
export function kmsPathLeavesBaseUrl(baseUrl: string, path: string): boolean {
    try {
        const base = new URL(baseUrl);
        const target = new URL(`${baseUrl.replace(/\/$/, "")}${path}`);
        return (
            target.origin !== base.origin ||
            target.username !== base.username ||
            target.password !== base.password
        );
    } catch {
        return true;
    }
}
