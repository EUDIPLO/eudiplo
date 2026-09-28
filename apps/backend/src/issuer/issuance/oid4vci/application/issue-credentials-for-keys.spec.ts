import { describe, expect, it, vi } from "vitest";
import { IssueCredentialsForKeys } from "./issue-credentials-for-keys.js";

describe("IssueCredentialsForKeys", () => {
    it("issues one credential per holder key in order", async () => {
        const issuer = {
            issue: vi
                .fn()
                .mockResolvedValueOnce("credential-1")
                .mockResolvedValueOnce("credential-2"),
        };
        const session = { id: "session-1", tenantId: "tenant-1" } as any;
        const useCase = new IssueCredentialsForKeys(issuer);

        await expect(
            useCase.execute({
                credentialConfigurationId: "credential-config",
                holderKeys: [{ kid: "one" } as any, { kid: "two" } as any],
                session,
                claims: { given_name: "Ada" },
                issuanceSetId: "set-1",
            }),
        ).resolves.toEqual(["credential-1", "credential-2"]);

        expect(issuer.issue.mock.calls).toEqual([
            [
                "credential-config",
                { kid: "one" },
                session,
                { given_name: "Ada" },
                "set-1",
            ],
            [
                "credential-config",
                { kid: "two" },
                session,
                { given_name: "Ada" },
                "set-1",
            ],
        ]);
    });

    it("preserves sequential failure behavior", async () => {
        const issuer = {
            issue: vi.fn().mockRejectedValue(new Error("issue failed")),
        };

        await expect(
            new IssueCredentialsForKeys(issuer).execute({
                credentialConfigurationId: "credential-config",
                holderKeys: [{ kid: "one" } as any],
                session: { id: "session-1", tenantId: "tenant-1" } as any,
                issuanceSetId: "set-1",
            }),
        ).rejects.toThrow("issue failed");
    });
});
