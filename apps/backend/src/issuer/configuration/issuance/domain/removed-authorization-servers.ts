/**
 * The OID4VP-backed chained authorization server (`vp` on a `chained` entry,
 * served at `/issuers/{tenant}/chained-as-vp`) was removed in EUDIPLO 9.0 in
 * favour of the `oid4vp` authorization server type.
 */
export const REMOVED_CHAINED_VP_MESSAGE =
    "The OID4VP-backed chained authorization server ('vp' on a 'chained' entry) was removed in EUDIPLO 9.0. Configure an authorization server of type 'oid4vp' with a presentationConfigId instead.";

interface ConfiguredServer {
    type?: string;
    id?: string;
    upstream?: unknown;
    vp?: unknown;
}

/** Whether an authorization server entry uses the removed `vp` option. */
export function usesRemovedChainedVp(server: unknown): boolean {
    const entry = server as ConfiguredServer | null | undefined;
    return entry?.type === "chained" && entry.vp !== undefined;
}

/**
 * Stored configurations may still contain entries with the removed `vp`
 * option, and must keep loading: a `chained` entry without `upstream` is
 * dropped, a `chained` entry with `upstream` keeps working as chained
 * authorization server without `vp`. Returns the ids of the changed entries.
 */
export function withoutRemovedChainedVp<T>(servers: T[]): {
    servers: T[];
    changedIds: string[];
} {
    const changedIds: string[] = [];
    const kept: T[] = [];
    for (const server of servers) {
        if (!usesRemovedChainedVp(server)) {
            kept.push(server);
            continue;
        }
        const { vp: _vp, ...entry } = server as ConfiguredServer;
        changedIds.push(entry.id ?? "");
        if (entry.upstream) {
            kept.push(entry as T);
        }
    }
    return { servers: kept, changedIds };
}
