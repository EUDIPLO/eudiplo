import { describe, expect, it, vi } from "vitest";
import { InvalidCredentialProof } from "../domain/credential-proof-errors.js";
import type { CredentialProofVerifier } from "../ports/credential-proof-verifier.js";
import { IssueCredentialsFromProofs } from "./issue-credentials-from-proofs.js";

describe("IssueCredentialsFromProofs", () => {
    const session = { id: "session-1", tenantId: "tenant-1" } as any;

    it("prepares verification once and issues/audits each JWT credential in order", async () => {
        const verify = vi.fn().mockResolvedValue([{ kid: "holder" }]);
        const prepare = vi.fn().mockResolvedValue({ verify });
        const issue = vi.fn().mockResolvedValue(["credential-jwt"]);
        const onIssued = vi.fn();
        const useCase = new IssueCredentialsFromProofs(
            { prepare } as unknown as CredentialProofVerifier,
            { execute: issue } as any,
        );

        await expect(
            useCase.execute({
                proofs: ["proof-1", "proof-2"],
                proofType: "jwt",
                session,
                credentialConfigurationId: "config-1",
                claims: { name: "Ada" },
                issuanceSetId: "set-1",
                trustLists: [],
                onIssued,
            }),
        ).resolves.toEqual([
            { credential: "credential-jwt" },
            { credential: "credential-jwt" },
        ]);

        expect(prepare).toHaveBeenCalledOnce();
        expect(verify).toHaveBeenNthCalledWith(1, "proof-1", "jwt");
        expect(issue).toHaveBeenNthCalledWith(1, {
            credentialConfigurationId: "config-1",
            holderKeys: [{ kid: "holder" }],
            session,
            claims: { name: "Ada" },
            issuanceSetId: "set-1",
        });
        expect(onIssued).toHaveBeenCalledTimes(2);
        expect(onIssued).toHaveBeenCalledWith("credential-jwt".length);
    });

    it("enforces the attested-key batch limit before issuing", async () => {
        const issue = vi.fn();
        const useCase = new IssueCredentialsFromProofs(
            {
                prepare: vi.fn().mockResolvedValue({
                    verify: vi
                        .fn()
                        .mockResolvedValue([{ kid: "one" }, { kid: "two" }]),
                }),
            } as unknown as CredentialProofVerifier,
            { execute: issue } as any,
        );

        await expect(
            useCase.execute({
                proofs: ["attestation"],
                proofType: "attestation",
                session,
                credentialConfigurationId: "config-1",
                issuanceSetId: "set-1",
                batchSize: 1,
                trustLists: [],
                onIssued: vi.fn(),
            }),
        ).rejects.toBeInstanceOf(InvalidCredentialProof);
        expect(issue).not.toHaveBeenCalled();
    });

    it("preserves sequential issue failure and does not report an unissued credential", async () => {
        const onIssued = vi.fn();
        const useCase = new IssueCredentialsFromProofs(
            {
                prepare: vi.fn().mockResolvedValue({
                    verify: vi.fn().mockResolvedValue([{ kid: "holder" }]),
                }),
            } as unknown as CredentialProofVerifier,
            {
                execute: vi.fn().mockRejectedValue(new Error("issuer failed")),
            } as any,
        );

        await expect(
            useCase.execute({
                proofs: ["proof"],
                proofType: "jwt",
                session,
                credentialConfigurationId: "config-1",
                issuanceSetId: "set-1",
                trustLists: [],
                onIssued,
            }),
        ).rejects.toThrow("issuer failed");
        expect(onIssued).not.toHaveBeenCalled();
    });
});
