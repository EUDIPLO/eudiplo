/**
 * Query parameters whose values never reach logs or traces. The session
 * search `q` can hold a pre-authorized code or a whole credential offer.
 */
export const REDACTED_QUERY_PARAMETERS: readonly string[] = ["q"];

const REDACTED = "[redacted]";

/**
 * The URL with the values of {@link REDACTED_QUERY_PARAMETERS} replaced.
 * Everything else, including the encoding of other parameters, is kept as is.
 */
export function redactUrl(url: string): string;
export function redactUrl(url: string | undefined): string | undefined;
export function redactUrl(url: string | undefined): string | undefined {
    const start = url?.indexOf("?") ?? -1;
    if (!url || start < 0) return url;
    const end = url.indexOf("#", start);
    const query = url.slice(start + 1, end < 0 ? undefined : end);
    const redacted = query
        .split("&")
        .map((pair) => {
            const separator = pair.indexOf("=");
            const name = separator < 0 ? pair : pair.slice(0, separator);
            return REDACTED_QUERY_PARAMETERS.includes(decodeName(name))
                ? `${name}=${REDACTED}`
                : pair;
        })
        .join("&");
    return `${url.slice(0, start + 1)}${redacted}${end < 0 ? "" : url.slice(end)}`;
}

function decodeName(name: string): string {
    try {
        return decodeURIComponent(name.replaceAll("+", " "));
    } catch {
        return name;
    }
}
