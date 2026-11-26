import Joi from "joi";
import { describe, expect, it } from "vitest";
import {
    declaredPlaceholderScopes,
    parseTenantKmsVariables,
    refusedConfigVariable,
} from "./config-variable-scope.js";

describe("configuration variable scope", () => {
    it("reads the placeholder scope from the schema, none by default", () => {
        const scopes = declaredPlaceholderScopes(
            Joi.object({
                PLAIN: Joi.string(),
                GLOBAL_ONLY: Joi.string().meta({ placeholder: "global" }),
                EVERYWHERE: Joi.string()
                    .meta({ group: "general" })
                    .meta({ placeholder: "any" }),
            }),
        );

        expect(Object.fromEntries(scopes)).toEqual({
            PLAIN: "none",
            GLOBAL_ONLY: "global",
            EVERYWHERE: "any",
        });
        expect(() =>
            declaredPlaceholderScopes(
                Joi.object({
                    TYPO: Joi.string().meta({ placeholder: "tenant" }),
                }),
            ),
        ).toThrow(/TYPO: unknown placeholder scope 'tenant'/);
    });

    it.each(["global", "tenant", "tenant-kms"] as const)(
        "refuses EUDIPLO's own settings in a %s file",
        (scope) => {
            for (const name of [
                "MASTER_SECRET",
                "AUTH_CLIENT_SECRET",
                "DB_PASSWORD",
                "S3_SECRET_ACCESS_KEY",
                "KMS_TENANT_VARIABLES",
            ]) {
                expect(
                    refusedConfigVariable(name, scope, new Set([name])),
                ).toContain("setting of EUDIPLO itself");
            }
        },
    );

    it("keeps the Vault and AWS settings to the global kms.json", () => {
        for (const name of ["VAULT_ADDR", "VAULT_TOKEN", "AWS_REGION"]) {
            expect(refusedConfigVariable(name, "global")).toBeUndefined();
            expect(refusedConfigVariable(name, "tenant")).toContain(
                "only the global kms.json",
            );
            expect(
                refusedConfigVariable(name, "tenant-kms", new Set([name])),
            ).toContain("only the global kms.json");
        }
    });

    it("allows PUBLIC_URL in every file", () => {
        for (const scope of ["global", "tenant", "tenant-kms"] as const) {
            expect(refusedConfigVariable("PUBLIC_URL", scope)).toBeUndefined();
        }
    });

    it("allows the operator's own variables, in a tenant kms.json only when listed", () => {
        expect(refusedConfigVariable("MY_TOKEN", "global")).toBeUndefined();
        expect(refusedConfigVariable("MY_TOKEN", "tenant")).toBeUndefined();
        expect(refusedConfigVariable("MY_TOKEN", "tenant-kms")).toContain(
            "not listed in KMS_TENANT_VARIABLES",
        );
        expect(
            refusedConfigVariable(
                "MY_TOKEN",
                "tenant-kms",
                new Set(["MY_TOKEN"]),
            ),
        ).toBeUndefined();
    });

    it("keeps the cloud credentials of the instance from the files of a tenant folder", () => {
        for (const [name, provider] of [
            ["AWS_ACCESS_KEY_ID", "AWS"],
            ["AWS_SECRET_ACCESS_KEY", "AWS"],
            ["AWS_SESSION_TOKEN", "AWS"],
            ["AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS"],
            ["AZURE_CLIENT_SECRET", "Azure"],
            ["AZURE_CLIENT_CERTIFICATE_PASSWORD", "Azure"],
            ["AZURE_PASSWORD", "Azure"],
        ]) {
            expect(refusedConfigVariable(name, "tenant")).toContain(
                `${provider} credentials of the instance`,
            );
            // The global kms.json documents them for an aws-kms provider.
            expect(refusedConfigVariable(name, "global")).toBeUndefined();
            // A tenant kms.json needs the operator's listing, as before.
            expect(refusedConfigVariable(name, "tenant-kms")).toContain(
                "not listed in KMS_TENANT_VARIABLES",
            );
            expect(
                refusedConfigVariable(name, "tenant-kms", new Set([name])),
            ).toBeUndefined();
            expect(parseTenantKmsVariables(name)).toEqual(new Set([name]));
        }
    });

    it("refuses only the listed cloud credentials, not every variable with their prefix", () => {
        for (const name of [
            "AZURE_TENANT_ID",
            "AZURE_CLIENT_ID",
            "AWS_ACCESS_KEY_ID_OF_PARTNER",
            "MY_AWS_SECRET_ACCESS_KEY",
        ]) {
            expect(refusedConfigVariable(name, "tenant")).toBeUndefined();
        }
    });

    it("parses KMS_TENANT_VARIABLES and refuses EUDIPLO's own settings in it", () => {
        expect(parseTenantKmsVariables(undefined)).toEqual(new Set());
        expect(parseTenantKmsVariables("")).toEqual(new Set());
        expect(parseTenantKmsVariables(" A_TOKEN , B_URL,PUBLIC_URL")).toEqual(
            new Set(["A_TOKEN", "B_URL", "PUBLIC_URL"]),
        );
        expect(() => parseTenantKmsVariables("A_TOKEN,MASTER_SECRET")).toThrow(
            /MASTER_SECRET is a setting of EUDIPLO itself/,
        );
        expect(() => parseTenantKmsVariables("VAULT_TOKEN")).toThrow(
            /VAULT_TOKEN is a setting of EUDIPLO itself/,
        );
        expect(() => parseTenantKmsVariables("a-token")).toThrow(
            /'a-token' is not a variable name/,
        );
    });
});
