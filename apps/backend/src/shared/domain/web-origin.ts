/**
 * Whether `value` is a web origin in its serialized form, as browsers send it
 * in the `Origin` header: `http` or `https` scheme, lower-case host, optional
 * non-default port, no path, query, fragment, credentials or trailing slash
 * (`https://shop.example`).
 */
export function isSerializedWebOrigin(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.origin === value
    );
}
