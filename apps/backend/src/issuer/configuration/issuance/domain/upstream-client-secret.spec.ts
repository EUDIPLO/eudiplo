import { describe, expect, it } from "vitest";
import { upstreamClientSecretUse } from "./upstream-client-secret.js";

describe("upstreamClientSecretUse", () => {
    it("names the field without the server's position", () => {
        expect(upstreamClientSecretUse("acme", "https://idp.example")).toEqual({
            scope: { type: "tenant", tenantId: "acme" },
            field: "IssuanceConfig:authorizationServers.*.upstream.clientSecret",
            destination: "https://idp.example",
        });
    });
});
