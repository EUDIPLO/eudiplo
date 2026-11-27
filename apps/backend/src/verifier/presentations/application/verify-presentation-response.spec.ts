import { createHash } from "node:crypto";
import { base64url } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../session/domain/session-data.js";
import type {
    CredentialVerificationResult,
    CredentialVerifierFormat,
} from "../domain/credential-verifier-format.js";
import {
    type DcqlCredentialMeta,
    UnknownClaimSetReferenceError,
} from "../domain/dcql-claim-policy.js";
import { TransactionDataBindingError } from "../domain/transaction-data-binding.js";
import { InvalidTrustedAuthoritiesError } from "../ports/trust-list-ref-resolver.js";
import { CredentialVerifierFormatRegistry } from "./credential-verifier-format-registry.js";
import {
    CredentialVerificationFailedError,
    IncompletePresentationError,
    MultiplePresentationsNotAllowedError,
    type PresentationQuery,
    UnknownPresentedCredentialError,
    VerifyPresentationResponse,
} from "./verify-presentation-response.js";

const encode = (value: unknown) =>
    base64url.encode(Buffer.from(JSON.stringify(value)));

function setup(
    /** Config credential queries; `meta` only goes into the request object. */
    credentials: Array<
        PresentationQuery["dcql_query"]["credentials"][number] & {
            meta?: DcqlCredentialMeta;
        }
    >,
    result: Partial<CredentialVerificationResult> = {},
    request: Record<string, unknown> = {},
    credentialSets?: PresentationQuery["dcql_query"]["credential_sets"],
    options: { allowUntrustedIssuers?: boolean } = {},
) {
    const format: CredentialVerifierFormat = {
        format: "dc+sd-jwt",
        verify: vi.fn().mockResolvedValue({
            verified: true,
            claims: { given_name: "Erika" },
            missingClaims: [],
            mismatchedClaims: [],
            ...result,
        }),
    };
    const trustLists = {
        resolveTrustListRefsForTenant: vi.fn().mockResolvedValue([]),
    };
    const useCase = new VerifyPresentationResponse(
        new CredentialVerifierFormatRegistry([format]),
        trustLists,
        { publicUrl: "https://eudiplo.example", skipOveraskingCheck: false },
    );
    const payload = {
        nonce: "request-nonce",
        dcql_query: {
            credentials: credentials.map((c) => ({
                ...c,
                format: "dc+sd-jwt",
            })),
        },
        ...request,
    };
    const session = {
        id: "session",
        tenantId: "tenant",
        vp_nonce: "nonce",
        requestObject: `${encode({ alg: "none" })}.${encode(payload)}.sig`,
    } as SessionData;
    const query: PresentationQuery = {
        tenantId: "tenant",
        // Most cases are about other checks; the requirement itself has its
        // own cases.
        allowUntrustedIssuers: options.allowUntrustedIssuers ?? true,
        dcql_query: { credentials, credential_sets: credentialSets },
    };
    const run = (vpToken: Record<string, string[]>) =>
        useCase.execute({ vp_token: vpToken }, query, session);
    return { run, format, trustLists };
}

describe("VerifyPresentationResponse", () => {
    it("returns the disclosed claims per credential id", async () => {
        const { run, format, trustLists } = setup([{ id: "pid" }]);

        await expect(run({ pid: ["vp"] })).resolves.toEqual([
            { id: "pid", values: [{ given_name: "Erika" }] },
        ]);
        expect(trustLists.resolveTrustListRefsForTenant).toHaveBeenCalledWith(
            undefined,
            "tenant",
            "https://eudiplo.example/issuers/tenant",
        );
        expect(format.verify).toHaveBeenCalledWith(
            "vp",
            expect.objectContaining({
                credentialId: "pid",
                binding: expect.objectContaining({
                    protocol: "openid4vp",
                    sessionNonce: "nonce",
                    request: expect.objectContaining({
                        nonce: "request-nonce",
                    }),
                }),
                claimSets: undefined,
            }),
        );
    });

    it("rejects credential queries without trusted_authorities before verifying anything", async () => {
        const { run, format } = setup(
            [
                {
                    id: "pid",
                    trusted_authorities: [
                        {
                            type: "etsi_tl",
                            values: [
                                { url: "https://trust.example/pid-issuers" },
                            ],
                        },
                    ],
                },
                { id: "mdl" },
            ],
            {},
            {},
            undefined,
            { allowUntrustedIssuers: false },
        );

        const error = await run({ pid: ["vp"], mdl: ["vp"] }).catch((e) => e);
        expect(error).toBeInstanceOf(InvalidTrustedAuthoritiesError);
        expect(error.message).toContain(
            "Credential queries without trusted_authorities: mdl.",
        );
        expect(format.verify).not.toHaveBeenCalled();
    });

    it("verifies credential queries with trusted_authorities without allowUntrustedIssuers", async () => {
        const authorities = [
            {
                type: "etsi_tl" as const,
                values: [{ url: "https://trust.example/pid-issuers" }],
            },
        ];
        const { run, trustLists } = setup(
            [{ id: "pid", trusted_authorities: authorities }],
            {},
            {},
            undefined,
            { allowUntrustedIssuers: false },
        );

        await expect(run({ pid: ["vp"] })).resolves.toEqual([
            { id: "pid", values: [{ given_name: "Erika" }] },
        ]);
        expect(trustLists.resolveTrustListRefsForTenant).toHaveBeenCalledWith(
            authorities[0].values,
            "tenant",
            "https://eudiplo.example/issuers/tenant",
        );
    });

    it("rejects missing credentials before verifying anything", async () => {
        const { run, format } = setup([{ id: "pid" }, { id: "mdl" }]);

        await expect(run({ pid: ["vp"] })).rejects.toBeInstanceOf(
            IncompletePresentationError,
        );
        expect(format.verify).not.toHaveBeenCalled();
    });

    it("does not count an empty presentation array as a presented credential", async () => {
        const { run, format } = setup([{ id: "mdl" }]);

        await expect(run({ mdl: [] })).rejects.toBeInstanceOf(
            IncompletePresentationError,
        );
        expect(format.verify).not.toHaveBeenCalled();
    });

    it("does not satisfy a credential set option with empty presentation arrays", async () => {
        const { run, format } = setup(
            [{ id: "pid" }, { id: "mdl" }, { id: "diploma" }],
            {},
            {},
            [
                {
                    options: [
                        ["pid", "diploma"],
                        ["mdl", "diploma"],
                    ],
                },
            ],
        );

        await expect(run({ pid: [], diploma: [] })).rejects.toBeInstanceOf(
            IncompletePresentationError,
        );
        await expect(run({ pid: ["vp"], diploma: [] })).rejects.toBeInstanceOf(
            IncompletePresentationError,
        );
        expect(format.verify).not.toHaveBeenCalled();
    });

    it("omits empty presentation arrays of optional credentials from the result", async () => {
        const { run } = setup([{ id: "pid" }, { id: "mdl" }], {}, {}, [
            { options: [["pid"], ["mdl"]] },
        ]);

        await expect(run({ pid: ["vp"], mdl: [] })).resolves.toEqual([
            { id: "pid", values: [{ given_name: "Erika" }] },
        ]);
    });

    it("rejects several presentations unless the query allows multiple", async () => {
        const single = setup([{ id: "pid" }]);
        await expect(
            single.run({ pid: ["vp1", "vp2"] }),
        ).rejects.toBeInstanceOf(MultiplePresentationsNotAllowedError);
        expect(single.format.verify).not.toHaveBeenCalled();

        const multiple = setup([{ id: "pid", multiple: true }]);
        await expect(multiple.run({ pid: ["vp1", "vp2"] })).resolves.toEqual([
            {
                id: "pid",
                values: [{ given_name: "Erika" }, { given_name: "Erika" }],
            },
        ]);
    });

    it("rejects credential ids outside the query", async () => {
        const { run } = setup([]);

        await expect(run({ other: ["vp"] })).rejects.toBeInstanceOf(
            UnknownPresentedCredentialError,
        );
    });

    it("rejects claim sets with unknown claim ids", async () => {
        const { run } = setup([
            {
                id: "pid",
                claims: [{ id: "a", path: ["a"] }],
                claim_sets: [["x"]],
            },
        ]);

        await expect(run({ pid: ["vp"] })).rejects.toBeInstanceOf(
            UnknownClaimSetReferenceError,
        );
    });

    it("reports format verification failures", async () => {
        const { run } = setup([{ id: "pid" }], {
            verified: false,
            failure: { type: "signature_invalid", message: "invalid" },
            docType: "eu.europa.ec.eudi.pid.1",
        } as Partial<CredentialVerificationResult>);

        const error = await run({ pid: ["vp"] }).catch((e) => e);
        expect(error).toBeInstanceOf(CredentialVerificationFailedError);
        expect(error.message).toBe("invalid");
        expect(error.failure.type).toBe("signature_invalid");
        // The requested format and docType feed the per-credential outcome.
        expect(error.credentialId).toBe("pid");
        expect(error.credential).toEqual({
            format: "dc+sd-jwt",
            docType: "eu.europa.ec.eudi.pid.1",
        });
    });

    it("rejects undisclosed claims and unsatisfied claim sets", async () => {
        const missing = setup([{ id: "pid" }], { missingClaims: ["ns.age"] });
        await expect(missing.run({ pid: ["vp"] })).rejects.toThrow(
            "Missing required claims for credential 'pid': ns.age",
        );

        const claimSet = setup(
            [
                {
                    id: "pid",
                    claims: [{ id: "a", path: ["a"] }],
                    claim_sets: [["a"]],
                },
            ],
            { claimSetSatisfied: false },
        );
        await expect(claimSet.run({ pid: ["vp"] })).rejects.toThrow(
            'Credential "pid" does not satisfy any claim_set',
        );
    });

    it("rejects claim value mismatches with a stable code before other claim violations", async () => {
        const { run } = setup(
            [
                {
                    id: "pid",
                    claims: [{ id: "a", path: ["a"], values: [true] }],
                    claim_sets: [["a"]],
                },
            ],
            {
                mismatchedClaims: ["a"],
                missingClaims: ["b"],
                claimSetSatisfied: false,
            },
        );

        const error = await run({ pid: ["vp"] }).catch((e) => e);
        expect(error).toBeInstanceOf(IncompletePresentationError);
        expect(error.code).toBe("claim_value_mismatch");
        expect(error.message).toBe(
            "Disclosed claim values do not match the requested values for credential 'pid': a",
        );
        expect(error.details).toEqual({ mismatchedClaims: { pid: ["a"] } });
    });

    describe("credential type", () => {
        it("rejects a credential whose vct is not in vct_values before claim violations", async () => {
            const { run } = setup(
                [{ id: "pid", meta: { vct_values: ["urn:eudi:pid:1"] } }],
                {
                    credentialType: "urn:eudi:other:1",
                    mismatchedClaims: ["a"],
                    missingClaims: ["b"],
                },
            );

            const error = await run({ pid: ["vp"] }).catch((e) => e);
            expect(error).toBeInstanceOf(IncompletePresentationError);
            expect(error.code).toBe("credential_type_mismatch");
            expect(error.message).toBe(
                "Credential 'pid' is not of a requested type: vct_values accepts urn:eudi:pid:1",
            );
            expect(error.message).not.toContain("urn:eudi:other:1");
        });

        it("rejects every presentation of a multiple query that has another type", async () => {
            const { run, format } = setup([
                {
                    id: "pid",
                    multiple: true,
                    meta: { vct_values: ["urn:eudi:pid:1"] },
                },
            ]);
            vi.mocked(format.verify)
                .mockResolvedValueOnce({
                    verified: true,
                    claims: {},
                    credentialType: "urn:eudi:pid:1",
                    missingClaims: [],
                    mismatchedClaims: [],
                })
                .mockResolvedValueOnce({
                    verified: true,
                    claims: {},
                    credentialType: "urn:eudi:other:1",
                    missingClaims: [],
                    mismatchedClaims: [],
                });

            const error = await run({ pid: ["vp1", "vp2"] }).catch((e) => e);
            expect(error.code).toBe("credential_type_mismatch");
        });

        it("accepts a credential whose vct is one of vct_values", async () => {
            const { run } = setup(
                [
                    {
                        id: "pid",
                        meta: { vct_values: ["urn:a", "urn:eudi:pid:1"] },
                    },
                ],
                { credentialType: "urn:eudi:pid:1" },
            );

            await expect(run({ pid: ["vp"] })).resolves.toEqual([
                { id: "pid", values: [{ given_name: "Erika" }] },
            ]);
        });

        it("rejects a credential without a type when the query sets one", async () => {
            const { run } = setup([
                { id: "pid", meta: { vct_values: ["urn:eudi:pid:1"] } },
            ]);

            const error = await run({ pid: ["vp"] }).catch((e) => e);
            expect(error.code).toBe("credential_type_mismatch");
        });

        it("compares with the meta of the request object, with <TENANT_URL> resolved", async () => {
            const vct = "https://eudiplo.example/issuers/tenant/vct/pid";
            const { run } = setup(
                [{ id: "pid", meta: { vct_values: ["<TENANT_URL>/vct/pid"] } }],
                { credentialType: vct },
                {
                    dcql_query: {
                        credentials: [
                            {
                                id: "pid",
                                format: "dc+sd-jwt",
                                meta: { vct_values: [vct] },
                            },
                        ],
                    },
                },
            );

            await expect(run({ pid: ["vp"] })).resolves.toHaveLength(1);
        });

        it("accepts any type when the query sets no meta", async () => {
            const { run } = setup([{ id: "pid" }], {
                credentialType: "urn:eudi:other:1",
            });

            await expect(run({ pid: ["vp"] })).resolves.toHaveLength(1);
        });
    });

    it("reports incomplete presentations without a failure code", async () => {
        const { run } = setup([{ id: "pid" }], { missingClaims: ["ns.age"] });

        const error = await run({ pid: ["vp"] }).catch((e) => e);
        expect(error).toBeInstanceOf(IncompletePresentationError);
        expect(error.code).toBeUndefined();
    });

    describe("transaction data", () => {
        const hash = (encoded: string) =>
            createHash("sha256").update(encoded).digest("base64url");
        const shared = encode({
            type: "payment",
            credential_ids: ["pid", "card"],
        });

        /** Verifies `pid` and `card`, with a KB-JWT per presentation. */
        const setupTwoCredentials = (
            keyBindings: Record<string, Record<string, unknown> | undefined>,
        ) => {
            const context = setup(
                [{ id: "pid" }, { id: "card" }],
                {},
                { transaction_data: [shared] },
            );
            vi.mocked(context.format.verify).mockImplementation(
                async (credential) => ({
                    verified: true,
                    claims: { credential },
                    missingClaims: [],
                    mismatchedClaims: [],
                    keyBinding: keyBindings[credential],
                }),
            );
            return context;
        };

        it("accepts an entry whose hash only one of its referenced credentials carries", async () => {
            const { run } = setupTwoCredentials({
                "pid-vp": {},
                "card-vp": { transaction_data_hashes: [hash(shared)] },
            });

            await expect(
                run({ pid: ["pid-vp"], card: ["card-vp"] }),
            ).resolves.toEqual([
                { id: "pid", values: [{ credential: "pid-vp" }] },
                { id: "card", values: [{ credential: "card-vp" }] },
            ]);
        });

        it("rejects an entry whose hash none of its referenced credentials carries", async () => {
            const { run } = setupTwoCredentials({
                "pid-vp": {},
                "card-vp": {},
            });

            const error = await run({
                pid: ["pid-vp"],
                card: ["card-vp"],
            }).catch((e) => e);
            expect(error).toBeInstanceOf(TransactionDataBindingError);
            expect(error.message).toContain(
                "any presented credential it references (pid, card)",
            );
        });

        it("rejects an entry when only formats without key-binding claims are presented", async () => {
            // mdoc returns no keyBinding: nothing could authorize the entry.
            const { run } = setupTwoCredentials({});

            const error = await run({
                pid: ["pid-vp"],
                card: ["card-vp"],
            }).catch((e) => e);
            expect(error).toBeInstanceOf(TransactionDataBindingError);
            expect(error.message).toContain(
                "Transaction data entry 0 references no presented SD-JWT VC (pid, card)",
            );
        });

        it("accepts an entry that one presented SD-JWT VC authorizes next to an mdoc", async () => {
            const { run } = setupTwoCredentials({
                "card-vp": { transaction_data_hashes: [hash(shared)] },
            });

            await expect(
                run({ pid: ["pid-vp"], card: ["card-vp"] }),
            ).resolves.toHaveLength(2);
        });

        it("reports credential verification failures before transaction data", async () => {
            // Neither carries the hash, so the binding check would fail too.
            const { run, format } = setupTwoCredentials({
                "pid-vp": {},
                "card-vp": {},
            });
            vi.mocked(format.verify).mockResolvedValueOnce({
                verified: false,
                failure: { message: "invalid" },
            });

            await expect(
                run({ pid: ["pid-vp"], card: ["card-vp"] }),
            ).rejects.toBeInstanceOf(CredentialVerificationFailedError);
        });

        it("checks TS12 claims against the request's response_mode", async () => {
            const ts12 = encode({
                type: "urn:eudi:sca:payment:1",
                credential_ids: ["pid"],
            });
            const keyBinding = {
                jti: "kb-1",
                transaction_data_hashes: [hash(ts12)],
                transaction_data_hashes_alg: "sha-256",
                amr: [{ knowledge: "pin" }, { possession: "device" }],
            };
            const runWith = (responseMode: string) => {
                const { run } = setup(
                    [{ id: "pid" }],
                    {
                        keyBinding: {
                            ...keyBinding,
                            response_mode: responseMode,
                        },
                    },
                    {
                        transaction_data: [ts12],
                        response_mode: "direct_post.jwt",
                    },
                );
                return run({ pid: ["vp"] });
            };

            await expect(runWith("direct_post.jwt")).resolves.toHaveLength(1);
            await expect(runWith("direct_post")).rejects.toThrow(
                "TS12 KB-JWT response_mode does not match the request",
            );
        });
    });
});
