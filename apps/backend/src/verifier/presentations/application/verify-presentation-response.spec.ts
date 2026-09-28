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
        dcql_query: { credentials },
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
        } as Partial<CredentialVerificationResult>);

        const error = await run({ pid: ["vp"] }).catch((e) => e);
        expect(error).toBeInstanceOf(CredentialVerificationFailedError);
        expect(error.message).toBe("invalid");
        expect(error.failure.type).toBe("signature_invalid");
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
