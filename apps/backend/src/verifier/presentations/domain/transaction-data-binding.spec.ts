import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    TransactionDataBindingError,
    type TransactionDataKeyBinding,
    type TransactionDataPresentation,
    verifyTransactionDataBinding,
} from "./transaction-data-binding.js";

const encode = (entry: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(entry)).toString("base64url");
const hash = (encoded: string, alg = "sha256") =>
    createHash(alg).update(encoded).digest("base64url");

const payment = encode({ type: "payment", credential_ids: ["pid"] });
const login = encode({
    type: "login",
    credential_ids: ["pid"],
    transaction_data_hashes_alg: ["sha-256", "sha-384"],
});
/** Either credential may authorize it. */
const shared = encode({ type: "payment", credential_ids: ["pid", "card"] });
const ts12 = encode({
    type: "urn:eudi:sca:payment:1",
    credential_ids: ["pid", "card"],
    payload: { transaction_id: "t-1" },
});
const ts12KeyBinding = {
    jti: "kb-1",
    response_mode: "direct_post.jwt",
    transaction_data_hashes_alg: "sha-256",
    amr: [{ knowledge: "pin" }, { possession: "device" }],
};

const presentation = (
    credentialId: string,
    keyBinding: TransactionDataKeyBinding,
    index = 0,
): TransactionDataPresentation => ({ credentialId, index, keyBinding });

const verify = (
    transactionData: string[] | undefined,
    presentations: TransactionDataPresentation[],
) =>
    verifyTransactionDataBinding({
        transactionData,
        presentations,
        responseMode: "direct_post.jwt",
    });

const rejection = (message: string | RegExp) =>
    expect.objectContaining({
        name: "TransactionDataBindingError",
        message:
            typeof message === "string"
                ? message
                : expect.stringMatching(message),
    });

describe("verifyTransactionDataBinding", () => {
    it("accepts a request without transaction data", async () => {
        await expect(
            verify(undefined, [
                presentation("pid", { transaction_data_hashes: ["x"] }),
            ]),
        ).resolves.toBeUndefined();
    });

    it("accepts the hashes of all entries in any order", async () => {
        await expect(
            verify(
                [payment, login],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(login), hash(payment)],
                    }),
                ],
            ),
        ).resolves.toBeUndefined();
    });

    describe("an entry referencing several credentials", () => {
        it("accepts the hash in only one of the presented credentials", async () => {
            await expect(
                verify(
                    [shared],
                    [
                        presentation("pid", {}),
                        presentation("card", {
                            transaction_data_hashes: [hash(shared)],
                        }),
                    ],
                ),
            ).resolves.toBeUndefined();
        });

        it("rejects the hash in only one of several presentations of a credential", async () => {
            // With `multiple`, the result does not say which presentation
            // authorized the entry, so each of them must carry the hash.
            await expect(
                verify(
                    [shared],
                    [
                        presentation("card", {}, 0),
                        presentation(
                            "card",
                            { transaction_data_hashes: [hash(shared)] },
                            1,
                        ),
                    ],
                ),
            ).rejects.toEqual(
                rejection(
                    "Transaction data entry 0 has its hash in only some presentations of 'card': presentation 0 of 'card' lack it",
                ),
            );
        });

        it("rejects the hash in only some presentations of a credential even when another credential carries it", async () => {
            await expect(
                verify(
                    [shared],
                    [
                        presentation("pid", {
                            transaction_data_hashes: [hash(shared)],
                        }),
                        presentation("card", {}, 0),
                        presentation(
                            "card",
                            { transaction_data_hashes: [hash(shared)] },
                            1,
                        ),
                    ],
                ),
            ).rejects.toEqual(rejection(/only some presentations of 'card'/));
        });

        it("accepts several presentations of a credential that all carry the hash, while another credential does not", async () => {
            await expect(
                verify(
                    [shared],
                    [
                        presentation("pid", {}),
                        presentation(
                            "card",
                            { transaction_data_hashes: [hash(shared)] },
                            0,
                        ),
                        presentation(
                            "card",
                            { transaction_data_hashes: [hash(shared)] },
                            1,
                        ),
                    ],
                ),
            ).resolves.toBeUndefined();
        });

        it("rejects it when no presented credential carries the hash", async () => {
            await expect(
                verify(
                    [shared],
                    [
                        presentation("pid", {}),
                        presentation("card", { transaction_data_hashes: [] }),
                    ],
                ),
            ).rejects.toEqual(
                rejection(
                    "Transaction data entry 0 has no matching hash in the key binding JWT of any presented credential it references (pid, card)",
                ),
            );
        });

        it("accepts the same hash in both credentials", async () => {
            await expect(
                verify(
                    [shared],
                    [
                        presentation("pid", {
                            transaction_data_hashes: [hash(shared)],
                        }),
                        presentation("card", {
                            transaction_data_hashes: [hash(shared)],
                        }),
                    ],
                ),
            ).resolves.toBeUndefined();
        });

        it("accepts two entries authorized by different credentials", async () => {
            const pidOnly = encode({
                type: "consent",
                credential_ids: ["pid"],
            });
            await expect(
                verify(
                    [shared, pidOnly],
                    [
                        // pid carries a hash, but not the shared entry's.
                        presentation("pid", {
                            transaction_data_hashes: [hash(pidOnly)],
                        }),
                        presentation("card", {
                            transaction_data_hashes: [hash(shared)],
                        }),
                    ],
                ),
            ).resolves.toBeUndefined();
        });
    });

    it("skips an entry that references no presented credential", async () => {
        const other = encode({ type: "other", credential_ids: ["mdl"] });
        await expect(
            verify([other], [presentation("pid", {})]),
        ).resolves.toBeUndefined();
    });

    it("skips an entry that cannot be decoded, and reads string credential_ids leniently", async () => {
        await expect(
            verify(["not-base64-json"], [presentation("pid", {})]),
        ).resolves.toBeUndefined();
        await expect(
            verify(
                [encode({ type: "payment", credential_ids: ["pid", 1] })],
                [presentation("pid", {})],
            ),
        ).rejects.toEqual(
            rejection("Transaction data entry 0 cannot be parsed"),
        );
    });

    it("accepts a hash algorithm the entry allows", async () => {
        await expect(
            verify(
                [login],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(login, "sha384")],
                        transaction_data_hashes_alg: "sha-384",
                    }),
                ],
            ),
        ).resolves.toBeUndefined();
    });

    it("rejects a hash algorithm the entry does not allow", async () => {
        await expect(
            verify(
                [payment],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(payment, "sha384")],
                        transaction_data_hashes_alg: "sha-384",
                    }),
                ],
            ),
        ).rejects.toEqual(
            rejection(
                "Transaction data entry 0 has no matching hash in the key binding JWT of any presented credential it references (pid): presentation 0 of 'pid' hashes with 'sha-384', which the entry does not allow (sha-256)",
            ),
        );
    });

    it("rejects an allowed hash algorithm EUDIPLO cannot check", async () => {
        const sha3 = encode({
            type: "payment",
            credential_ids: ["pid"],
            transaction_data_hashes_alg: ["sha3-256"],
        });
        await expect(
            verify(
                [sha3],
                [
                    presentation("pid", {
                        transaction_data_hashes: ["x"],
                        transaction_data_hashes_alg: "sha3-256",
                    }),
                ],
            ),
        ).rejects.toEqual(rejection(/which EUDIPLO cannot check$/));
    });

    it("rejects one hash matching two identical entries", async () => {
        await expect(
            verify(
                [payment, payment],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(payment)],
                    }),
                ],
            ),
        ).rejects.toEqual(
            rejection(
                "Transaction data hashes do not match the transaction data entries one to one",
            ),
        );
    });

    it("accepts two identical entries with two identical hashes", async () => {
        await expect(
            verify(
                [payment, payment],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(payment), hash(payment)],
                    }),
                ],
            ),
        ).resolves.toBeUndefined();
    });

    it("accepts two identical entries hashed in two different credentials", async () => {
        await expect(
            verify(
                [shared, shared],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(shared)],
                    }),
                    presentation("card", {
                        transaction_data_hashes: [hash(shared)],
                    }),
                ],
            ),
        ).resolves.toBeUndefined();
    });

    it("rejects a KB-JWT that carries only a wrong hash", async () => {
        await expect(
            verify(
                [payment],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(login)],
                    }),
                ],
            ),
        ).rejects.toEqual(
            rejection(
                "Transaction data entry 0 has no matching hash in the key binding JWT of any presented credential it references (pid)",
            ),
        );
    });

    it("accepts a KB-JWT that repeats an entry's hash", async () => {
        // Every hash belongs to an entry referencing the credential, so the
        // repetition authorizes nothing else.
        await expect(
            verify(
                [payment],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(payment), hash(payment)],
                    }),
                ],
            ),
        ).resolves.toBeUndefined();
    });

    it("rejects a hash that matches no entry referencing the credential", async () => {
        await expect(
            verify(
                [payment],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(payment), hash(login)],
                    }),
                ],
            ),
        ).rejects.toEqual(
            rejection(
                "The key binding JWT of presentation 0 of 'pid' contains a transaction data hash that matches no transaction data entry referencing 'pid'",
            ),
        );
    });

    it("ignores the key binding of a credential no entry references", async () => {
        await expect(
            verify(
                [payment],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(payment)],
                    }),
                    presentation("card", { transaction_data_hashes: [1, 2] }),
                ],
            ),
        ).resolves.toBeUndefined();
    });

    it("rejects the hash of an entry that does not reference the credential", async () => {
        const forCard = encode({ type: "consent", credential_ids: ["card"] });
        await expect(
            verify(
                [payment, forCard],
                [
                    presentation("pid", {
                        transaction_data_hashes: [hash(payment), hash(forCard)],
                    }),
                    presentation("card", {
                        transaction_data_hashes: [hash(forCard)],
                    }),
                ],
            ),
        ).rejects.toEqual(
            rejection(/of 'pid' contains a transaction data hash/),
        );
    });

    it("rejects an entry that cannot be parsed", async () => {
        await expect(
            verify(
                [
                    encode({
                        type: "payment",
                        credential_ids: ["pid"],
                        transaction_data_hashes_alg: "sha-256",
                    }),
                ],
                [presentation("pid", { transaction_data_hashes: ["x"] })],
            ),
        ).rejects.toEqual(
            rejection("Transaction data entry 0 cannot be parsed"),
        );
    });

    it.each([
        [
            "transaction_data_hashes that are not strings",
            { transaction_data_hashes: [1] },
            /not an array of strings/,
        ],
        [
            "a transaction_data_hashes_alg that is not a string",
            {
                transaction_data_hashes: [hash(payment)],
                transaction_data_hashes_alg: ["sha-256"],
            },
            /not a string/,
        ],
        ["no transaction_data_hashes", {}, /has no matching hash/],
    ])("rejects a KB-JWT with %s", async (_, keyBinding, message) => {
        await expect(
            verify([payment], [presentation("pid", keyBinding)]),
        ).rejects.toEqual(rejection(message));
    });

    describe("TS12 entries", () => {
        it("requires the TS12 claims only in the credential that carries the hash", async () => {
            await expect(
                verify(
                    [ts12],
                    [
                        presentation("pid", {}),
                        presentation("card", {
                            ...ts12KeyBinding,
                            transaction_data_hashes: [hash(ts12)],
                        }),
                    ],
                ),
            ).resolves.toBeUndefined();
        });

        it.each([
            [
                "a jti",
                { jti: undefined },
                "TS12 KB-JWT requires a non-empty jti",
            ],
            [
                "the request's response_mode",
                { response_mode: "direct_post" },
                "TS12 KB-JWT response_mode does not match the request",
            ],
            [
                "transaction_data_hashes_alg sha-256",
                { transaction_data_hashes_alg: undefined },
                "TS12 KB-JWT requires transaction_data_hashes_alg sha-256",
            ],
            [
                "an amr array",
                { amr: undefined },
                "TS12 KB-JWT requires an amr array",
            ],
            [
                "two factor categories",
                { amr: [{ knowledge: "pin" }, { knowledge: "password" }] },
                "TS12 KB-JWT amr requires at least two distinct SCA factor categories",
            ],
        ])(
            "requires %s in the carrying KB-JWT",
            async (_, override, message) => {
                await expect(
                    verify(
                        [ts12],
                        [
                            presentation("card", {
                                ...ts12KeyBinding,
                                transaction_data_hashes: [hash(ts12)],
                                ...override,
                            }),
                        ],
                    ),
                ).rejects.toEqual(rejection(message));
            },
        );
    });

    it("throws TransactionDataBindingError", async () => {
        await expect(
            verify([payment], [presentation("pid", {})]),
        ).rejects.toBeInstanceOf(TransactionDataBindingError);
    });
});
