import { describe, expect, it } from "vitest";
import { ConfiguredIssuerRegistrationCertificateProvider } from "./configured-issuer-registration-certificate-provider.js";

const now = () => Math.floor(Date.now() / 1000);
const jwt = (payload: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

describe("ConfiguredIssuerRegistrationCertificateProvider", () => {
    const provider = new ConfiguredIssuerRegistrationCertificateProvider();

    it("serves the configured certificate while it is valid", async () => {
        const active = jwt({ exp: now() + 3600 });
        await expect(
            provider.resolve("t", { enabled: true, jwt: active }),
        ).resolves.toBe(active);
    });

    it("serves nothing without a JWT, or with one that has expired, is not yet valid or is no JWT", async () => {
        for (const settings of [
            { enabled: true },
            { enabled: true, jwt: jwt({ exp: now() - 3600 }) },
            { enabled: true, jwt: jwt({ nbf: now() + 3600 }) },
            { enabled: true, jwt: "not-a-jwt" },
        ]) {
            await expect(provider.resolve("t", settings)).resolves.toBe(
                undefined,
            );
        }
    });
});
