import { describe, expect, it } from "vitest";
import { oidcDiscoveryUrl } from "./oidc-discovery-url.js";

describe("oidcDiscoveryUrl", () => {
    it.each([
        [
            "https://keycloak.example/realms/eudiplo",
            "https://keycloak.example/realms/eudiplo/.well-known/openid-configuration",
        ],
        [
            "https://auth.example/application/o/eudiplo/",
            "https://auth.example/application/o/eudiplo/.well-known/openid-configuration",
        ],
        [
            "https://login.example",
            "https://login.example/.well-known/openid-configuration",
        ],
    ])("appends the well-known path to %s", (issuer, url) => {
        expect(oidcDiscoveryUrl(issuer)).toBe(url);
    });
});
