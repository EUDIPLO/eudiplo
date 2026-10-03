import { base64url } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { SessionData } from "../../../session/domain/session-data.js";
import type {
    CredentialVerificationResult,
    CredentialVerifierFormat,
} from "../domain/credential-verifier-format.js";
import { UnknownClaimSetReferenceError } from "../domain/dcql-claim-policy.js";
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
    credentials: PresentationQuery["dcql_query"]["credentials"],
    result: Partial<CredentialVerificationResult> = {},
    request: Record<string, unknown> = {},
    credentialSets?: PresentationQuery["dcql_query"]["credential_sets"],
) {
    const format: CredentialVerifierFormat = {
        format: "dc+sd-jwt",
        verify: vi.fn().mockResolvedValue({
            verified: true,
            claims: { given_name: "Erika" },
            missingClaims: [],
            ...result,
        }),
    };
    const trustLists = {
        resolveTrustListRefsForTenant: vi.fn().mockResolvedValue([]),
    };
    const useCase = new VerifyPresentationResponse(
        new CredentialVerifierFormatRegistry([format]),
        trustLists,
        { publicUrl: "https://eudiplo.example" },
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

    it("passes only the transaction data that references the credential", async () => {
        const forPid = encode({
            type: "urn:eudi:sca:payment",
            credential_ids: ["pid"],
        });
        const forOther = encode({ type: "other", credential_ids: ["other"] });
        const { run, format } = setup(
            [{ id: "pid" }],
            {},
            {
                transaction_data: [forPid, forOther],
            },
        );

        await run({ pid: ["vp"] });
        const { options } = vi.mocked(format.verify).mock.calls[0][1];
        expect(options.transactionData).toEqual([forPid]);
        expect(options.ts12TransactionData).toBe(true);
    });
});
