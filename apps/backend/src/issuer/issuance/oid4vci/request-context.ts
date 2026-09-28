export interface Oid4vciRequestContext {
    body: Record<string, unknown> | string | undefined;
    contentType: string;
    headers: Readonly<Record<string, string | string[] | undefined>>;
    method: string;
    url: string;
}
