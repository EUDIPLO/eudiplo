import { describe, expect, it, vi } from "vitest";
import type { TokenPayload } from "../../../auth/token.decorator.js";
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

    function service() {
        const record = vi.fn();
        const instance = Object.assign(Object.create(Service.prototype), {
            repo: {
                findForTenant: vi.fn().mockResolvedValue(existing),
                save: vi.fn(async (value) => value),
                deleteForTenant: vi.fn(),
            },
            tenantActionLogService: { record },
            outboundUrlPolicyService: { assertSafeUrl: vi.fn() },
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
});
