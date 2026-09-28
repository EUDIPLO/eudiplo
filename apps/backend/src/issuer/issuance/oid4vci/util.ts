/**
 * Normalize protocol authentication headers without depending on a web framework.
 * @returns
 */
export function normalizeRequestHeaders(
    requestHeaders: object,
): globalThis.Headers {
    const headers = new Headers();

    const normalizeAuthorizationHeader = (value: string): string => {
        const trimmed = value.trim();
        const separatorIndex = trimmed.indexOf(" ");
        if (separatorIndex === -1) {
            return trimmed;
        }

        const scheme = trimmed.slice(0, separatorIndex);
        const credentials = trimmed.slice(separatorIndex + 1).trim();
        if (!credentials) {
            return trimmed;
        }

        const lowerScheme = scheme.toLowerCase();
        let normalizedScheme = scheme;
        if (lowerScheme === "dpop") {
            normalizedScheme = "DPoP";
        } else if (lowerScheme === "bearer") {
            normalizedScheme = "Bearer";
        }

        return `${normalizedScheme} ${credentials}`;
    };

    for (const [key, value] of Object.entries(requestHeaders)) {
        if (Array.isArray(value)) {
            for (const v of value) {
                if (typeof v !== "string") {
                    continue;
                }
                const normalizedValue =
                    key.toLowerCase() === "authorization"
                        ? normalizeAuthorizationHeader(v)
                        : v;
                headers.append(key, normalizedValue);
            }
        } else if (typeof value === "string") {
            const normalizedValue =
                key.toLowerCase() === "authorization"
                    ? normalizeAuthorizationHeader(value)
                    : value;
            headers.set(key, normalizedValue);
        }
    }

    return headers;
}
