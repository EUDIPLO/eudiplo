import { describe, expect, it } from "vitest";
import type { KmsProviderConfig } from "../schemas/kms-config.schema.js";
import {
    kmsCredentials,
    kmsCredentialUse,
    withCredential,
} from "./kms-credential-references.js";

const provider = (config: Record<string, unknown>) =>
    config as unknown as KmsProviderConfig;
const tenant = { type: "tenant", tenantId: "acme" } as const;

describe("KMS credential references", () => {
    it("lists the credentials of every provider type, and only those", () => {
        expect(
            kmsCredentials(
                provider({
                    id: "v",
                    type: "vault",
                    vaultUrl: "https://vault.example",
                    vaultToken: "${vault:kv/eudiplo/acme/kms#token}",
                }),
            ),
        ).toEqual([
            {
                path: ["vaultToken"],
                value: "${vault:kv/eudiplo/acme/kms#token}",
            },
        ]);
        expect(
            kmsCredentials(
                provider({
                    id: "c",
                    type: "csc",
                    baseUrl: "https://csc.example",
                    tokenUrl: "https://csc.example/token",
                    clientId: "client",
                    clientSecret: "secret",
                    sad: "sad",
                    authorizeAuthData: [{ id: "otp", value: "123" }],
                }),
            ).map((credential) => credential.path.join(".")),
        ).toEqual(["clientSecret", "sad", "authorizeAuthData.0.value"]);
        expect(
            kmsCredentials(
                provider({
                    id: "a",
                    type: "aws-kms",
                    region: "eu-central-1",
                    accessKeyId: "AKIA",
                    secretAccessKey: "secret",
                }),
            ).map((credential) => credential.path.join(".")),
        ).toEqual(["secretAccessKey"]);
    });

    it("replaces one credential, leaving the provider as it was", () => {
        const original = provider({
            id: "h",
            type: "http",
            baseUrl: "https://kms.example",
            auth: { type: "bearer", token: "${env:ACME_TOKEN}" },
        });
        const resolved = withCredential(original, ["auth", "token"], "value");
        expect(resolved).toEqual({
            id: "h",
            type: "http",
            baseUrl: "https://kms.example",
            auth: { type: "bearer", token: "value" },
        });
        expect(
            (original as unknown as { auth: { token: string } }).auth.token,
        ).toBe("${env:ACME_TOKEN}");
    });

    it("names the field and the address the credential is sent to", () => {
        expect(
            kmsCredentialUse(
                tenant,
                provider({
                    id: "v",
                    type: "vault",
                    vaultUrl: "https://vault.example",
                }),
                ["vaultToken"],
            ),
        ).toEqual({
            scope: tenant,
            field: "KmsConfig:providers.*.vaultToken",
            destination: "https://vault.example",
        });
        expect(
            kmsCredentialUse(
                tenant,
                provider({
                    id: "h",
                    type: "http",
                    baseUrl: "https://kms.example",
                    auth: { tokenUrl: "https://idp.example/token" },
                }),
                ["auth", "clientSecret"],
            ).destination,
        ).toBe("https://idp.example/token");
        expect(
            kmsCredentialUse(
                { type: "instance" },
                provider({ id: "a", type: "aws-kms", region: "eu-west-1" }),
                ["secretAccessKey"],
            ).destination,
        ).toBe("https://kms.eu-west-1.amazonaws.com");
        // No position in a list: also nested items are `*`.
        expect(
            kmsCredentialUse(
                tenant,
                provider({
                    id: "c",
                    type: "csc",
                    baseUrl: "https://csc.example",
                }),
                ["authorizeAuthData", 3, "value"],
            ).field,
        ).toBe("KmsConfig:providers.*.authorizeAuthData.*.value");
        // Only a region name becomes an address.
        expect(
            kmsCredentialUse(
                { type: "instance" },
                provider({
                    id: "a",
                    type: "aws-kms",
                    region: "eu-central-1.amazonaws.com#x",
                }),
                ["secretAccessKey"],
            ).destination,
        ).toBeUndefined();
        // A PKCS#11 pin goes to a library of the host, which is no URL.
        expect(
            kmsCredentialUse(
                tenant,
                provider({
                    id: "p",
                    type: "pkcs11",
                    library: "/usr/lib/softhsm/libsofthsm2.so",
                }),
                ["pin"],
            ).destination,
        ).toBe("/usr/lib/softhsm/libsofthsm2.so");
    });
});
