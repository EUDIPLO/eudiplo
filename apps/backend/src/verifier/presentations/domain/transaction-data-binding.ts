import { createHash } from "node:crypto";
import {
    HashAlgorithm,
    Oauth2ServerErrorResponseError,
} from "@openid4vc/oauth2";
import {
    Openid4vpVerifier,
    parseTransactionData,
    type TransactionDataEntry,
} from "@openid4vc/openid4vp";

/**
 * Key-binding JWT claims of an SD-JWT VC presentation that transaction data
 * is checked against. Values come from the wallet and are not validated yet.
 */
export interface TransactionDataKeyBinding {
    transaction_data_hashes?: unknown;
    transaction_data_hashes_alg?: unknown;
    jti?: unknown;
    response_mode?: unknown;
    amr?: unknown;
}

/** One presentation of a credential whose transaction data binding is checked. */
export interface TransactionDataPresentation {
    /** DCQL credential query id the presentation answers. */
    credentialId: string;
    /** Position among the presentations of `credentialId`, for messages. */
    index: number;
    keyBinding: TransactionDataKeyBinding;
}

/** The presentations do not authorize the transaction data of the request. */
export class TransactionDataBindingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TransactionDataBindingError";
    }
}

const notUsedForTransactionData = (): never => {
    throw new Error("Not used to verify transaction data");
};

/**
 * Checks transaction data hashes. `verifyTransactionData` only uses the
 * `hash` callback.
 */
const transactionDataVerifier = new Openid4vpVerifier({
    callbacks: {
        // HashAlgorithm values are sha-256, sha-384 and sha-512.
        hash: (data, alg) =>
            createHash(alg.replace("-", "")).update(data).digest(),
        signJwt: notUsedForTransactionData,
        verifyJwt: notUsedForTransactionData,
        encryptJwe: notUsedForTransactionData,
        decryptJwe: notUsedForTransactionData,
    },
});

const supportedHashAlgorithms: string[] = Object.values(HashAlgorithm);

interface Holder {
    presentation: TransactionDataPresentation;
    hashes: string[];
    alg: string;
    /** Hash occurrences not yet used up by an entry (one-to-one check). */
    unused: string[];
    /** Hashes that belong to an entry referencing the credential. */
    known: Set<string>;
    /** Carries the hash of a TS12 entry, so needs the TS12 claims. */
    ts12: boolean;
}

/**
 * Checks that the presentations authorize the request's transaction data
 * (OID4VP 1.0 §5.1, §8.4 and Appendix B.3.3.1).
 *
 * The wallet uses only one of the credentials an entry's `credential_ids`
 * reference to authorize it (§5.1), so each entry must have its hash in the
 * KB-JWTs of at least one presented credential it references, not of each.
 * A credential query answered with several presentations (`multiple`)
 * authorizes the entry only when each of them carries the hash, since the
 * result does not say which presentation authorized it; the hash in only
 * some of them fails the response.
 * A hash is computed over the entry exactly as sent, with the KB-JWT's
 * `transaction_data_hashes_alg` (default `sha-256`), which the entry's own
 * `transaction_data_hashes_alg` (default `sha-256` only) must allow.
 *
 * Further rules:
 * - one hash occurrence authorizes one entry, so identical entries need one
 *   hash each;
 * - a KB-JWT of a referenced credential carries only hashes of entries that
 *   reference it; the same hash in several referenced presentations, or
 *   repeated in one, is accepted. Presentations of credentials no entry references are not
 *   checked;
 * - every presentation that carries the hash of a TS12 entry
 *   (`urn:eudi:sca:` types) needs the TS12 key-binding claims;
 * - an entry that references no presentation given here fails the response:
 *   it references only credentials the wallet did not present (for example
 *   one a `credential_sets` alternative leaves out), mdoc credentials, whose
 *   transaction data EUDIPLO cannot check (OID4VP 1.0 Appendix B.2.1 leaves
 *   it to each type), or ids that are not in the query. Otherwise such an
 *   entry, for example a TS12 payment, would pass without the holder
 *   authorizing it.
 *
 * Throws `TransactionDataBindingError` when a rule is broken.
 *
 * @param transactionData Base64url-encoded entries exactly as sent in the
 *   signed request
 * @param presentations SD-JWT VC presentations of the response
 * @param responseMode `response_mode` of the signed request, which TS12
 *   KB-JWTs repeat
 */
export async function verifyTransactionDataBinding({
    transactionData,
    presentations,
    responseMode,
}: {
    transactionData: string[] | undefined;
    presentations: TransactionDataPresentation[];
    responseMode: string | undefined;
}): Promise<void> {
    if (!transactionData?.length) {
        return;
    }

    const entries = transactionData.map(parseEntry);
    // Credentials no entry references are not checked at all.
    const holders = presentations
        .filter(({ credentialId }) =>
            entries.some(({ credential_ids }) =>
                credential_ids.includes(credentialId),
            ),
        )
        .map(toHolder);

    for (const [index, encoded] of transactionData.entries()) {
        const entry = entries[index];
        const candidates = holders.filter(({ presentation }) =>
            entry.credential_ids.includes(presentation.credentialId),
        );
        if (candidates.length === 0) {
            throw new TransactionDataBindingError(
                `Transaction data entry ${index} references no presented SD-JWT VC (${entry.credential_ids.join(", ")}), so nothing authorizes it; EUDIPLO checks transaction data only in SD-JWT VC key binding JWTs`,
            );
        }

        const allowedAlgs = entry.transaction_data_hashes_alg ?? [
            HashAlgorithm.Sha256,
        ];
        const reasons: string[] = [];
        // Per referenced credential id, the entry's hash in each of its
        // presentations (undefined where a presentation lacks it).
        const groups = new Map<
            string,
            Array<{ holder: Holder; hash: string | undefined }>
        >();
        for (const holder of candidates) {
            const hash = await entryHash(encoded, holder, allowedAlgs, reasons);
            if (hash) {
                holder.known.add(hash);
            }
            const { credentialId } = holder.presentation;
            groups.set(credentialId, [
                ...(groups.get(credentialId) ?? []),
                { holder, hash },
            ]);
        }

        // A credential id authorizes the entry when every one of its
        // presentations carries the hash: with `multiple`, the result does
        // not tell which presentation authorized it. One that carries it in
        // only some presentations is ambiguous and rejected.
        const carriers: Array<Array<{ holder: Holder; hash: string }>> = [];
        for (const [credentialId, group] of groups) {
            const missing = group.filter(({ hash }) => !hash);
            if (missing.length === 0) {
                carriers.push(group as Array<{ holder: Holder; hash: string }>);
            } else if (missing.length < group.length) {
                throw new TransactionDataBindingError(
                    `Transaction data entry ${index} has its hash in only some presentations of '${credentialId}': ${missing.map(({ holder }) => describe(holder)).join(", ")} lack it`,
                );
            }
        }

        if (carriers.length === 0) {
            throw new TransactionDataBindingError(
                `Transaction data entry ${index} has no matching hash in the key binding JWT of any presented credential it references (${[...groups.keys()].join(", ")})${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`,
            );
        }

        // The library finds an entry's hash anywhere in the list, so two
        // identical entries could share one hash. Each entry uses up one
        // occurrence of its hash in every presentation that authorizes it.
        const carrier = carriers.find((group) =>
            group.every(({ holder, hash }) => holder.unused.includes(hash)),
        );
        if (!carrier) {
            throw new TransactionDataBindingError(
                "Transaction data hashes do not match the transaction data entries one to one",
            );
        }
        for (const { holder, hash } of carrier) {
            holder.unused.splice(holder.unused.indexOf(hash), 1);
        }

        if (entry.type.startsWith("urn:eudi:sca:")) {
            for (const group of groups.values()) {
                for (const { holder, hash } of group) {
                    if (hash) holder.ts12 = true;
                }
            }
        }
    }

    for (const holder of holders) {
        if (holder.hashes.some((hash) => !holder.known.has(hash))) {
            throw new TransactionDataBindingError(
                `The key binding JWT of ${describe(holder)} contains a transaction data hash that matches no transaction data entry referencing '${holder.presentation.credentialId}'`,
            );
        }
        if (holder.ts12) {
            validateTs12KeyBinding(
                holder.presentation.keyBinding,
                responseMode,
            );
        }
    }
}

function toHolder(presentation: TransactionDataPresentation): Holder {
    const {
        transaction_data_hashes: hashes,
        transaction_data_hashes_alg: alg,
    } = presentation.keyBinding;
    if (
        hashes !== undefined &&
        !(
            Array.isArray(hashes) &&
            hashes.every((hash) => typeof hash === "string")
        )
    ) {
        throw new TransactionDataBindingError(
            `The key binding JWT of ${describePresentation(presentation)} has transaction_data_hashes that are not an array of strings`,
        );
    }
    if (alg !== undefined && typeof alg !== "string") {
        throw new TransactionDataBindingError(
            `The key binding JWT of ${describePresentation(presentation)} has a transaction_data_hashes_alg that is not a string`,
        );
    }
    const list = (hashes as string[] | undefined) ?? [];
    return {
        presentation,
        hashes: list,
        alg: alg ?? HashAlgorithm.Sha256,
        unused: [...list],
        known: new Set(),
        ts12: false,
    };
}

/**
 * The entry's hash in the holder's KB-JWT, or undefined when it has none or
 * hashes with an algorithm the entry does not allow (noted in `reasons`).
 */
async function entryHash(
    encoded: string,
    holder: Holder,
    allowedAlgs: string[],
    reasons: string[],
): Promise<string | undefined> {
    if (holder.hashes.length === 0) {
        return undefined;
    }
    if (!allowedAlgs.includes(holder.alg)) {
        reasons.push(
            `${describe(holder)} hashes with '${holder.alg}', which the entry does not allow (${allowedAlgs.join(", ")})`,
        );
        return undefined;
    }
    if (!supportedHashAlgorithms.includes(holder.alg)) {
        reasons.push(
            `${describe(holder)} hashes with '${holder.alg}', which EUDIPLO cannot check`,
        );
        return undefined;
    }
    return carriedHash(encoded, holder);
}

/** The entry's hash in the holder's KB-JWT, or undefined when it has none. */
async function carriedHash(
    encoded: string,
    holder: Holder,
): Promise<string | undefined> {
    const { credentialId } = holder.presentation;
    try {
        const [verified] = await transactionDataVerifier.verifyTransactionData({
            transactionData: [encoded],
            credentials: {
                [credentialId]: [
                    {
                        transaction_data_hashes: holder.hashes,
                        transaction_data_hashes_alg: holder.alg,
                    },
                ],
            },
        });
        return verified.presentations[0].hash;
    } catch (error) {
        // The algorithm is checked before, so the library only rejects here
        // because the KB-JWT does not carry the entry's hash.
        if (error instanceof Oauth2ServerErrorResponseError) {
            return undefined;
        }
        throw error;
    }
}

function parseEntry(encoded: string, index: number): TransactionDataEntry {
    try {
        return parseTransactionData({ transactionData: [encoded] })[0]
            .transactionData;
    } catch {
        throw new TransactionDataBindingError(
            `Transaction data entry ${index} cannot be parsed`,
        );
    }
}

function describe(holder: Holder): string {
    return describePresentation(holder.presentation);
}

function describePresentation({
    credentialId,
    index,
}: TransactionDataPresentation): string {
    return `presentation ${index} of '${credentialId}'`;
}

/** TS12 SCA requires additional key-binding claims. */
function validateTs12KeyBinding(
    keyBinding: TransactionDataKeyBinding,
    expectedResponseMode: string | undefined,
): void {
    if (typeof keyBinding.jti !== "string" || !keyBinding.jti) {
        throw new TransactionDataBindingError(
            "TS12 KB-JWT requires a non-empty jti",
        );
    }
    if (keyBinding.response_mode !== expectedResponseMode) {
        throw new TransactionDataBindingError(
            "TS12 KB-JWT response_mode does not match the request",
        );
    }
    if (keyBinding.transaction_data_hashes_alg !== HashAlgorithm.Sha256) {
        throw new TransactionDataBindingError(
            "TS12 KB-JWT requires transaction_data_hashes_alg sha-256",
        );
    }
    if (!Array.isArray(keyBinding.amr)) {
        throw new TransactionDataBindingError(
            "TS12 KB-JWT requires an amr array",
        );
    }

    const categories = new Set(
        keyBinding.amr.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return [];
            }
            return Object.keys(entry as Record<string, unknown>).filter((key) =>
                ["knowledge", "possession", "inherence"].includes(key),
            );
        }),
    );
    if (categories.size < 2) {
        throw new TransactionDataBindingError(
            "TS12 KB-JWT amr requires at least two distinct SCA factor categories",
        );
    }
}
