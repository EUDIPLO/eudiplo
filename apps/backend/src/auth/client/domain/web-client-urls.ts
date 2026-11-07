/**
 * Whether `value` is an address the web client can be served from: an `http`
 * or `https` URL, optionally with a path, without query, fragment,
 * credentials or `*`.
 */
export function isWebClientUrl(value: string): boolean {
    if (value.includes("*") || value.includes("?") || value.includes("#")) {
        return false;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
    );
}
