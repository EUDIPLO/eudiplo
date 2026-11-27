import { describe, expect, it, vi } from "vitest";
import { stubSecretReferences } from "../../../../test/secrets/secret-test-sources.js";
import type { TokenPayload } from "../../../auth/token.decorator.js";
import { SecretReferences } from "../../../platform/secrets/application/secret-references.js";
import { AttributeProviderService } from "../attribute-provider/attribute-provider.service.js";
import { WebhookEndpointService } from "./webhook-endpoint.service.js";

const token = { client: { clientId: "admin" } } as TokenPayload;
const auth = (value: string) => ({
    type: "apiKey" as const,
    config: { headerName: "X-Key", value },
});

describe.each([
    ["WebhookEndpointService", WebhookEndpointService],
    ["AttributeProviderService", AttributeProviderService],
])("%s audit log", (_name, Service) => {
    const existing = {
        id: "e",
        tenantId: "t",
        name: "Endpoint",
        url: "https://endpoint.example",
        description: null,
        auth: auth("old-key"),
    };

    function service(secrets = new SecretReferences()) {
        const record = vi.fn();
        const instance = Object.assign(Object.create(Service.prototype), {
            repo: {
                // Only the stored entry exists; a create needs a free ID.
                findForTenant: vi.fn(async (_tenantId: string, id: string) =>
                    id === existing.id ? existing : null,
                ),
                existsForTenant: vi.fn(
                    async (_tenantId: string, id: string) => id === existing.id,
                ),
                create: vi.fn(async (value) => value),
                save: vi.fn(async (value) => value),
                deleteForTenant: vi.fn(),
            },
            tenantActionLogService: { record },
            outboundUrlPolicyService: { assertSafeUrl: vi.fn() },
            // Attribute providers only: no credential config names it.
            references: { find: vi.fn().mockResolvedValue([]) },
            secrets,
        }) as WebhookEndpointService;
        vi.spyOn(instance, "getById").mockResolvedValue(existing);
        return { instance, record };
    }

    it("lists a new API key as a changed field without storing either key", async () => {
        const { instance, record } = service();

        await instance.update("t", "e", { auth: auth("new-key") }, token);

        const [entry] = record.mock.calls[0];
        expect(entry.changedFields).toEqual(["auth"]);
        expect(entry.before.auth).toEqual(auth("[REDACTED]"));
        expect(entry.after.auth).toEqual(auth("[REDACTED]"));
        expect(JSON.stringify(entry)).not.toMatch(/old-key|new-key/);
    });

    it("redacts the API key of a deleted entry", async () => {
        const { instance, record } = service();

        await instance.delete("t", "e", token);

        const [entry] = record.mock.calls[0];
        expect(entry.before.auth).toEqual(auth("[REDACTED]"));
    });

    describe("with a secret policy", () => {
        const reference = "${vault:kv/eudiplo/t/shop#token}";

        it("shows a secret reference in the audit entry", async () => {
            const { instance, record } = service(
                stubSecretReferences().secrets,
            );

            await instance.update("t", "e", { auth: auth(reference) }, token);

            const [entry] = record.mock.calls[0];
            expect(entry.before.auth).toEqual(auth("[REDACTED]"));
            expect(entry.after.auth).toEqual(auth(reference));
        });

        it("refuses a reference outside the tenant's grant on create and update", async () => {
            const { instance } = service(stubSecretReferences().secrets);
            const foreign = auth("${vault:kv/eudiplo/other/shop#token}");

            await expect(
                instance.create("t", {
                    id: "n",
                    name: "New",
                    url: "https://endpoint.example",
                    auth: foreign,
                } as never),
            ).rejects.toThrow(/auth\.config\.value: .*no grant of tenant 't'/);
            await expect(
                instance.update("t", "e", { auth: foreign }),
            ).rejects.toThrow(/no grant of tenant 't'/);
            const { repo } = instance as unknown as {
                repo: { save: unknown; create: unknown };
            };
            expect(repo.create).not.toHaveBeenCalled();
            expect(repo.save).not.toHaveBeenCalled();
        });

        it("keeps the stored entry when a folder file names a refused reference", async () => {
            const { instance } = service(stubSecretReferences().secrets);
            const importConfigsForTenant = vi.fn();
            Object.assign(instance, {
                configImportService: { importConfigsForTenant },
            });
            await (
                instance as unknown as {
                    importForTenant(tenantId: string): Promise<void>;
                }
            ).importForTenant("t");
            const { deleteExisting } = importConfigsForTenant.mock.calls[0][1];
            const repo = (
                instance as unknown as {
                    repo: { deleteForTenant: ReturnType<typeof vi.fn> };
                }
            ).repo;

            await expect(
                deleteExisting("t", {
                    ...existing,
                    auth: auth("${vault:kv/eudiplo/other/shop#token}"),
                }),
            ).rejects.toThrow(/auth\.config\.value/);
            expect(repo.deleteForTenant).not.toHaveBeenCalled();

            await deleteExisting("t", existing);
            expect(repo.deleteForTenant).toHaveBeenCalledWith("t", "e");
        });

        it("refuses a malformed reference instead of storing it as text", async () => {
            const { instance } = service(stubSecretReferences().secrets);

            await expect(
                instance.update("t", "e", { auth: auth("${vault:no-key}") }),
            ).rejects.toThrow(/auth\.config\.value/);
        });

        it("checks a stored reference again when only the URL changes", async () => {
            const { secrets } = stubSecretReferences({
                tenants: {
                    t: {
                        bound: [
                            {
                                ref: "${vault:kv/operator/shop#token}",
                                fields: [
                                    `${_name.replace("Service", "")}:auth.config.value`,
                                ],
                                destinations: ["https://endpoint.example"],
                            },
                        ],
                    },
                },
            });
            const { instance } = service(secrets);
            const bound = auth("${vault:kv/operator/shop#token}");
            vi.spyOn(instance, "getById").mockResolvedValue({
                ...existing,
                auth: bound,
            });

            await expect(
                instance.update("t", "e", {
                    url: "https://endpoint.example/v2",
                }),
            ).resolves.toBeDefined();
            await expect(
                instance.update("t", "e", { url: "https://elsewhere.example" }),
            ).rejects.toThrow(/auth\.config\.value/);
        });
    });
});
