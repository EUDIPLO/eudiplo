import { describe, expect, it } from "vitest";
import { ConfigResourceRouteService } from "./config-resource-route.service.js";

describe("ConfigResourceRouteService", () => {
    const service = new ConfigResourceRouteService();

    it("matches singleton, collection, and item mutations", () => {
        expect(service.match("PUT", "/api/key-chain/providers/config")).toEqual(
            {
                kind: "KmsConfig",
                id: "kms",
                create: false,
            },
        );
        expect(
            service.match("POST", "/api/issuer/credentials", { id: "pid" }),
        ).toEqual({ kind: "CredentialConfig", id: "pid", create: true });
        expect(
            service.match("PATCH", "/api/verifier/config/age-check"),
        ).toEqual({
            kind: "PresentationConfig",
            id: "age-check",
            create: false,
        });
        expect(service.match("PATCH", "/api/tenant/tenant-a")).toEqual({
            kind: "Tenant",
            id: "tenant",
            create: false,
            tenantId: "tenant-a",
        });
    });

    it("treats the default access key chain as the tenant settings", () => {
        expect(service.match("PUT", "/api/key-chain/access/default")).toEqual({
            kind: "Tenant",
            id: "tenant",
            create: false,
        });
    });

    it("does not confuse key import with a key named import", () => {
        expect(
            service.match("POST", "/api/key-chain/import", { id: "issuer" }),
        ).toEqual({ kind: "KeyChain", id: "issuer", create: true });
    });

    it("ignores bundle operations and unrelated operational endpoints", () => {
        expect(
            service.match("POST", "/api/config-bundles/import", {}),
        ).toBeUndefined();
        expect(
            service.match("POST", "/api/registrar/access-certificate", {}),
        ).toBeUndefined();
        expect(
            service.match(
                "POST",
                "/api/issuer/config/registration-cert/reissue",
                {},
            ),
        ).toBeUndefined();
        expect(
            service.match(
                "POST",
                "/api/verifier/config/issuer-metadata/resolve",
                {},
            ),
        ).toBeUndefined();
        expect(
            service.match("POST", "/api/key-chain/issuer/rotate", {}),
        ).toBeUndefined();
    });
});
