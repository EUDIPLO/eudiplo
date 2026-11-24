import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigImportService } from "./config-import.service.js";

describe("ConfigImportService.replacePlaceholders", () => {
    function createService(settings: Record<string, string> = {}) {
        return new ConfigImportService(
            { get: vi.fn((key: string) => settings[key]) } as any,
            {} as any,
        );
    }

    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv("MASTER_SECRET", "master-secret-do-not-leak");
        vi.stubEnv("VAULT_TOKEN", "instance-vault-token");
        vi.stubEnv("PUBLIC_URL", "https://issuer.example.com");
        vi.stubEnv("WEBHOOK_KEY", "webhook-key");
    });

    it("resolves the operator's variables and PUBLIC_URL in a tenant file", () => {
        expect(
            createService().replacePlaceholders({
                url: "${PUBLIC_URL}/hook",
                auth: { value: "${WEBHOOK_KEY}" },
                fallback: "${UNSET_VARIABLE:default}",
            }),
        ).toEqual({
            url: "https://issuer.example.com/hook",
            auth: { value: "webhook-key" },
            fallback: "default",
        });
    });

    it.each([
        "${MASTER_SECRET}",
        "https://attacker.example.com/${MASTER_SECRET}",
        "${MASTER_SECRET:fallback}",
        "${VAULT_TOKEN}",
    ])("refuses %s in a tenant file in every strict mode", (value) => {
        for (const mode of ["abort", "skip", "ignore"]) {
            try {
                createService({
                    CONFIG_VARIABLE_STRICT: mode,
                }).replacePlaceholders({ webhook: { url: value } });
                expect.unreachable("expected the variable to be refused");
            } catch (error) {
                expect((error as Error).message).toMatch(
                    /names a setting of EUDIPLO itself/,
                );
                expect((error as Error).message).not.toMatch(
                    /do-not-leak|instance-vault-token|fallback/,
                );
            }
        }
    });

    it("resolves only listed variables in a tenant kms.json", () => {
        const service = createService({ KMS_TENANT_VARIABLES: "WEBHOOK_KEY" });

        expect(
            service.replacePlaceholders(
                { token: "${WEBHOOK_KEY}" },
                "tenant-kms",
            ),
        ).toEqual({ token: "webhook-key" });
        // KmsConfigService keeps this form as text, so it is not resolved here.
        expect(() =>
            service.replacePlaceholders(
                { description: "${WEBHOOK_KEY:x}" },
                "tenant-kms",
            ),
        ).toThrow(/does not support \$\{VAR:default\}/);
        vi.stubEnv("OTHER_KEY", "other-key");
        expect(() =>
            service.replacePlaceholders(
                { token: "${OTHER_KEY}" },
                "tenant-kms",
            ),
        ).toThrow(/OTHER_KEY.*not listed in KMS_TENANT_VARIABLES/);
    });
});
