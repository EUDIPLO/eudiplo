import { describe, expect, it } from "vitest";
import {
    escapeConfigPlaceholders,
    parseSecretReference,
    readConfigFileValues,
    resolveConfigVariables,
} from "./config-values.js";

/** An environment that fails the test when anything reads it. */
const untouchedEnv = new Proxy(
    {},
    {
        get: (_target, name) => {
            throw new Error(`read ${String(name)}`);
        },
    },
) as Record<string, string>;

describe("secret references", () => {
    it("parses env, vault and required references", () => {
        expect(parseSecretReference("${env:SHOP_TOKEN}")).toEqual({
            ok: true,
            reference: {
                source: "env",
                reference: "${env:SHOP_TOKEN}",
                variable: "SHOP_TOKEN",
            },
        });
        expect(
            parseSecretReference("${vault:kv/eudiplo/tenants/acme/shop#token}"),
        ).toEqual({
            ok: true,
            reference: {
                source: "vault",
                reference: "${vault:kv/eudiplo/tenants/acme/shop#token}",
                mount: "kv",
                path: "eudiplo/tenants/acme/shop",
                field: "token",
            },
        });
        expect(parseSecretReference("${vault:kv/a:b/c:d#api-key@12}")).toEqual({
            ok: true,
            reference: {
                source: "vault",
                reference: "${vault:kv/a:b/c:d#api-key@12}",
                mount: "kv",
                path: "a:b/c:d",
                field: "api-key",
                version: 12,
            },
        });
        expect(
            parseSecretReference("${required:WebhookEndpoint/shop/auth}"),
        ).toEqual({
            ok: true,
            reference: {
                source: "required",
                reference: "${required:WebhookEndpoint/shop/auth}",
                hint: "WebhookEndpoint/shop/auth",
            },
        });
    });

    it("refuses malformed references with a message", () => {
        const refused: Array<[string, RegExp]> = [
            ["${env:lower}", /A-Z, 0-9 and _/],
            ["${env:A-B}", /A-Z, 0-9 and _/],
            ["${vault:kv/app}", /after #/],
            ["${vault:kv#token}", /<mount>\/<path>#<key>/],
            ["${vault:kv//app#token}", /empty, \. or \.\./],
            ["${vault:kv/a/../b#token}", /empty, \. or \.\./],
            ["${vault:kv/./b#token}", /empty, \. or \.\./],
            ["${vault:/kv/app#token}", /empty/],
            ["${vault:kv/app#}", /key after #/],
            ["${vault:kv/app#a/b}", /key after #/],
            ["${vault:kv/app#token@0}", /positive number/],
            ["${vault:kv/app#token@1@2}", /positive number/],
            ["${vault:kv/app#token@x}", /positive number/],
            ["${vault:kv/app#token@1234567890}", /positive number/],
            ["${vault:kv/app#token@}", /positive number/],
            // A reference has no default.
            ["${env:A:fallback}", /A-Z, 0-9 and _/],
            ["${vault:kv/a#t:fallback}", /key after #/],
            ["${vault:kv/a@b/app#token}", /<mount>\/<path>#<key>/],
            ["${aws-sm:arn:aws:secretsmanager:x#k}", /not available/],
            ["${azure-kv:vault/name}", /not available/],
            ["${foo:bar}", /unknown source 'foo'; use one of env, vault/],
        ];
        for (const [value, message] of refused) {
            const parsed = parseSecretReference(value);
            expect(parsed, value).toMatchObject({ ok: false });
            if (parsed && !parsed.ok) {
                expect(parsed.message, value).toMatch(message);
                // The locator alone, not only with its source.
                expect(parsed.message, value).not.toContain(
                    value.slice(value.indexOf(":") + 1, -1),
                );
            }
        }
    });

    it("finds no reference where the value is something else", () => {
        for (const value of [
            "plain text",
            "${SHOP_TOKEN}",
            "${SHOP_TOKEN:default}",
            "Bearer ${env:SHOP_TOKEN}",
            "${env:SHOP_TOKEN} ",
            "$${env:SHOP_TOKEN}",
            "${env:}",
            "${env}",
            "${env:A B}",
            "${env:A",
            "${Env:A}",
            "${1env:A}",
            "${env:${env:A}}",
            "${vault:kv/app#token}${vault:kv/app#token}",
        ])
            expect(parseSecretReference(value), value).toBeUndefined();
    });

    it("lists references apart from placeholders and resolves none of them", () => {
        const file = {
            auth: { value: "${vault:kv/acme/shop#token}" },
            url: "${PUBLIC_URL}/hooks",
            header: "Bearer ${env:TOKEN}",
            text: "$${vault:kv/acme/shop#token}",
            lower: "${lower}",
            unknown: "${foo:bar}",
        };
        expect(readConfigFileValues(file)).toEqual({
            value: { ...file, text: "${vault:kv/acme/shop#token}" },
            placeholders: [
                { path: "/url", placeholder: "${PUBLIC_URL}", whole: false },
            ],
            references: [
                {
                    path: "/auth/value",
                    reference: "${vault:kv/acme/shop#token}",
                    whole: true,
                },
                {
                    path: "/header",
                    reference: "${env:TOKEN}",
                    whole: false,
                },
                { path: "/unknown", reference: "${foo:bar}", whole: true },
            ],
        });
        // The resolver reads only PUBLIC_URL and reports no reference.
        const read: string[] = [];
        const env = new Proxy({} as Record<string, string>, {
            get: (_target, name) => {
                read.push(String(name));
                return name === "PUBLIC_URL" ? "https://eudiplo" : undefined;
            },
        });
        const resolved = resolveConfigVariables(file, env);
        expect(read).toEqual(["PUBLIC_URL"]);
        expect(resolved.issues).toEqual([]);
        expect(resolved.value).toEqual({
            ...file,
            url: "https://eudiplo/hooks",
            text: "${vault:kv/acme/shop#token}",
        });
    });

    it("finds no reference inside the default of a placeholder", () => {
        expect(readConfigFileValues({ v: "${X:${env:A}}" })).toEqual({
            value: { v: "${X:${env:A}}" },
            placeholders: [
                { path: "/v", placeholder: "${X:${env:A}", whole: false },
            ],
            references: [],
        });
    });

    it("accepts a vault version of up to nine digits", () => {
        expect(
            parseSecretReference("${vault:kv/app#token@999999999}"),
        ).toMatchObject({ ok: true, reference: { version: 999_999_999 } });
    });

    it("cannot keep a reference right after a filled-in value that ends in $", () => {
        // A file has no way to write a `$` followed by a placeholder: `$${`
        // is always the escaped form. The reference becomes text, as a
        // `${VAR}` left open does in the same place; it is never resolved.
        const sent = resolveConfigVariables(
            { v: "${A}${vault:kv/a#t}" },
            { A: "$" },
            "keep",
        ).value;
        expect(sent).toEqual({ v: "$${vault:kv/a#t}" });
        expect(readConfigFileValues(sent)).toEqual({
            value: { v: "${vault:kv/a#t}" },
            placeholders: [],
            references: [],
        });
    });

    it("keeps references as references in a file that is sent on", () => {
        const sent = resolveConfigVariables(
            {
                reference: "${vault:kv/acme/shop#token}",
                text: "$${vault:kv/acme/shop#token}",
                filled: "${SET}",
            },
            { SET: "${vault:kv/other#token}" },
            "keep",
        ).value;
        expect(sent).toEqual({
            reference: "${vault:kv/acme/shop#token}",
            text: "$${vault:kv/acme/shop#token}",
            // A value filled in never becomes a reference.
            filled: "$${vault:kv/other#token}",
        });
        expect(readConfigFileValues(sent).references).toEqual([
            {
                path: "/reference",
                reference: "${vault:kv/acme/shop#token}",
                whole: true,
            },
        ]);
    });

    it("gives stored text that looks like a reference back as text", () => {
        const stored = { value: "${vault:kv/acme/shop#token}" };
        const file = escapeConfigPlaceholders(stored);
        expect(file.value).toBe("$${vault:kv/acme/shop#token}");
        expect(readConfigFileValues(file)).toEqual({
            value: stored,
            placeholders: [],
            references: [],
        });
        expect(resolveConfigVariables(file, untouchedEnv).value).toEqual(
            stored,
        );
    });

    it("keeps a kms.json, which has no escaped form, as it is", () => {
        const kms = "$${vault:kv/a#t} ${vault:kv/a#t}";
        expect(resolveConfigVariables(kms, untouchedEnv, "none").value).toBe(
            kms,
        );
    });

    it("scans unterminated references in linear time", () => {
        for (const input of [
            "${vault:kv/a".repeat(100_000),
            "${a:".repeat(100_000),
            "${a".repeat(100_000),
            `\${vault:${"a".repeat(1_000_000)}`,
        ]) {
            const started = performance.now();
            expect(resolveConfigVariables(input, {}).value).toBe(input);
            expect(readConfigFileValues(input).references).toEqual([]);
            expect(parseSecretReference(input)).toBeUndefined();
            expect(performance.now() - started).toBeLessThan(1000);
        }
    });
});
