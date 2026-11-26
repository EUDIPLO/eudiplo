import { describe, expect, it } from "vitest";
import {
    envSource,
    reference,
} from "../../../../test/secrets/secret-test-sources.js";

const env = (name: string) => reference(`\${env:${name}}`);

const source = envSource({
    SHOP_TOKEN: "token",
    EMPTY: "",
    MASTER_SECRET: "master",
});
const signal = new AbortController().signal;

describe("EnvSecretSource", () => {
    it("reads a variable and treats an empty one as unset", async () => {
        expect((await source.read(env("SHOP_TOKEN"), signal))?.reveal()).toBe(
            "token",
        );
        expect(await source.read(env("EMPTY"), signal)).toBeUndefined();
        expect(await source.read(env("UNSET"), signal)).toBeUndefined();
    });

    it("accepts names and prefixes as grants", () => {
        for (const pattern of ["SHOP_TOKEN", "ACME_*", "A*"])
            expect(source.validatePattern(pattern, "tenant"), pattern).toBe(
                undefined,
            );
        // Every variable, also those the platform injects: instance only.
        expect(source.validatePattern("*", "instance")).toBeUndefined();
        expect(source.validatePattern("*", "tenant")).toMatch(
            /cannot be granted every variable/,
        );
        for (const pattern of ["shop", "A*B", "ACME-*", "**", ""])
            expect(source.validatePattern(pattern, "tenant"), pattern).toMatch(
                /variable name/,
            );
    });

    it("refuses settings of EUDIPLO by name, for tenants and the instance", () => {
        expect(source.validatePattern("MASTER_SECRET", "instance")).toMatch(
            /no reference can name/,
        );
        expect(source.refusal(env("MASTER_SECRET"), "instance")).toMatch(
            /no reference can name/,
        );
        expect(source.validatePattern("VAULT_TOKEN", "tenant")).toMatch(
            /only the instance/,
        );
        expect(source.refusal(env("VAULT_TOKEN"), "tenant")).toMatch(
            /only the instance/,
        );
        expect(source.refusal(env("VAULT_TOKEN"), "instance")).toBeUndefined();
        expect(source.refusal(env("SHOP_TOKEN"), "tenant")).toBeUndefined();
    });

    it("matches names exactly and prefixes without settings or tenant cloud credentials", () => {
        expect(source.within(env("SHOP_TOKEN"), "SHOP_TOKEN", "tenant")).toBe(
            true,
        );
        expect(source.within(env("SHOP_TOKEN_2"), "SHOP_TOKEN", "tenant")).toBe(
            false,
        );
        expect(source.within(env("ACME_SHOP"), "ACME_*", "tenant")).toBe(true);
        expect(source.within(env("ACMEX_SHOP"), "ACME_*", "tenant")).toBe(
            false,
        );
        // A prefix never covers a setting of EUDIPLO.
        expect(source.within(env("PUBLIC_URL"), "*", "instance")).toBe(false);
        expect(source.within(env("VAULT_TOKEN"), "VAULT_*", "instance")).toBe(
            false,
        );
        // The cloud credentials of the instance: by name only, for tenants.
        expect(
            source.within(env("AWS_SECRET_ACCESS_KEY"), "AWS_*", "tenant"),
        ).toBe(false);
        expect(
            source.within(env("AWS_SECRET_ACCESS_KEY"), "AWS_*", "instance"),
        ).toBe(true);
        expect(
            source.within(
                env("AWS_SECRET_ACCESS_KEY"),
                "AWS_SECRET_ACCESS_KEY",
                "tenant",
            ),
        ).toBe(true);
    });

    it("finds grants that contain others", () => {
        const cases: Array<[string, string, boolean]> = [
            ["ACME_*", "ACME_X_*", true],
            ["ACME_*", "ACME_TOKEN", true],
            ["ACME_X_*", "ACME_*", false],
            ["ACME_TOKEN", "ACME_*", false],
            ["ACME_TOKEN", "ACME_TOKEN", true],
            ["*", "ANY_*", true],
            ["ACME_*", "ACMEX_*", false],
        ];
        for (const [outer, inner, contained] of cases)
            expect(source.contains(outer, inner), `${outer} ${inner}`).toBe(
                contained,
            );
    });

    it("finds overlapping grants", () => {
        const cases: Array<[string, string, boolean]> = [
            ["ACME_*", "ACME_X_*", true],
            ["ACME_X_*", "ACME_*", true],
            ["ACME_*", "ACMEX_*", false],
            ["ACME_*", "ACME_TOKEN", true],
            ["ACME_TOKEN", "ACME_*", true],
            ["ACME_TOKEN", "ACME_TOKEN", true],
            ["ACME_TOKEN", "ACME_TOKEN2", false],
            ["*", "ANY", true],
        ];
        for (const [a, b, overlap] of cases)
            expect(source.overlaps(a, b), `${a} ${b}`).toBe(overlap);
    });
});
