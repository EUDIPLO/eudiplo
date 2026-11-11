/**
 * Which DCQL credential queries a transaction data entry may reference.
 *
 * EUDIPLO checks transaction data only in the key binding JWTs of SD-JWT VC
 * presentations (see `verifyTransactionDataBinding`). `credential_ids` tells
 * the wallet which credentials may authorize the entry (OID4VP 1.0 §5.1), so
 * it may name only `dc+sd-jwt` queries: a wallet that authorized with an
 * mdoc would be rejected, and an entry without a checkable credential fails
 * every response. Such entries are refused when the configuration is saved
 * or the request is created. Whether the wallet presents a referenced
 * credential when `credential_sets` offers an alternative is only known from
 * the response, so that is checked there.
 *
 * Pure function; the caller decides how a violation is reported.
 */

/** The subset of a transaction data entry the check needs. */
export interface TransactionDataReferences {
    credential_ids: readonly string[];
}

/** The subset of a DCQL credential query the check needs. */
export interface TransactionDataCredentialQuery {
    id: string;
    format: string;
}

/**
 * Why the transaction data cannot be authorized by the credential queries,
 * or undefined when each entry names at least one credential query and only
 * `dc+sd-jwt` queries of the DCQL query (OID4VP 1.0 §5.1: each references a
 * requested credential).
 */
export function uncheckableTransactionData(
    transactionData: readonly TransactionDataReferences[] | null | undefined,
    credentials: readonly TransactionDataCredentialQuery[],
): string | undefined {
    const formats = new Map(
        credentials.map((credential) => [credential.id, credential.format]),
    );
    const problems = (transactionData ?? []).flatMap((entry, index) => {
        const ids = entry.credential_ids;
        if (ids.length === 0) {
            return [
                `transaction_data[${index}].credential_ids names no credential query`,
            ];
        }
        const unknown = ids.filter((id) => !formats.has(id));
        if (unknown.length > 0) {
            return [
                `transaction_data[${index}].credential_ids names ids that are not in the DCQL query: ${unknown.join(", ")}`,
            ];
        }
        const other = ids.filter((id) => formats.get(id) !== "dc+sd-jwt");
        if (other.length > 0) {
            return [
                `transaction_data[${index}].credential_ids names credential queries that are not dc+sd-jwt: ${other.join(", ")}; EUDIPLO checks transaction data only in SD-JWT VC presentations`,
            ];
        }
        return [];
    });
    return problems.length > 0 ? problems.join("; ") : undefined;
}
