import { describe, expect, it } from "vitest";
import {
    envSource,
    reference,
    StubVaultSource,
} from "../../../../test/secrets/secret-test-sources.js";
import { SecretPolicyError } from "../domain/secret-errors.js";
import type { SecretUse } from "../domain/secret-use.js";
import { SecretPolicy } from "./secret-policy.js";

const sources = [envSource({}), new StubVaultSource()];

const tenant = (
    tenantId: string,
    field = "WebhookEndpoint:auth.config.value",
    destination?: string,
): SecretUse => ({ scope: { type: "tenant", tenantId }, field, destination });

const instance = (field = "KmsConfig:providers.0.vaultToken"): SecretUse => ({
    scope: { type: "instance" },
    field,
});

const issuesOf = (input: unknown): string[] => {
    try {
        SecretPolicy.create(input, sources);
    } catch (error) {
        if (error instanceof SecretPolicyError) return error.issues;
        throw error;
    }
    return [];
};

const CSC = "${vault:kv/operator/csc#clientSecret}";
const SHARED_HUB = "${vault:kv/operator/hub#token}";

describe("SecretPolicy", () => {
    const policy = SecretPolicy.create(
        {
            $schema: "https://eudiplo.dev/schemas/SecretPolicyFile.schema.json",
            instance: {
                env: ["*", "VAULT_TOKEN"],
                vault: ["kv/eudiplo/instance/"],
                bound: [
                    {
                        ref: "${env:VAULT_TOKEN}",
                        fields: ["KmsConfig:providers.*.vaultToken"],
                        destinations: ["https://vault.example"],
                    },
                ],
            },
            tenants: {
                "*": {
                    vault: ["kv/eudiplo/tenants/{tenant}/"],
                    bound: [
                        {
                            ref: SHARED_HUB,
                            fields: ["WebhookEndpoint:auth.config.value"],
                            destinations: ["https://hub.example"],
                        },
                    ],
                },
                acme: {
                    env: ["ACME_*", "SHARED_KMS_TOKEN"],
                    vault: ["kv/eudiplo/tenants/acme/"],
                    bound: [
                        {
                            ref: CSC,
                            fields: ["KmsConfig:providers.*.clientSecret"],
                            destinations: ["https://csc.example.eu"],
                        },
                        {
                            ref: CSC,
                            fields: ["KmsConfig:providers.*.sad"],
                            destinations: ["https://sad.example.eu"],
                        },
                    ],
                },
                "acme-2": { env: ["ACME2_*"] },
            },
        },
        sources,
    );

    it("lets a tenant name what its own namespaces hold", () => {
        for (const text of [
            "${env:ACME_SHOP_TOKEN}",
            "${env:SHARED_KMS_TOKEN}",
            "${vault:kv/eudiplo/tenants/acme/shop#token}",
            "${vault:kv/eudiplo/tenants/acme/deep/path#token@2}",
        ])
            expect(policy.refusal(reference(text), tenant("acme")), text).toBe(
                undefined,
            );
    });

    it("keeps tenants out of each other's namespaces", () => {
        const refused: Array<[string, string]> = [
            ["${env:ACME2_TOKEN}", "acme"],
            ["${env:ACME_TOKEN}", "acme-2"],
            ["${vault:kv/eudiplo/tenants/acme-2/shop#token}", "acme"],
            ["${vault:kv/eudiplo/tenants/acme/shop#token}", "acme-2"],
            // A prefix of another ID is no namespace of its own.
            ["${vault:kv/eudiplo/tenants/acme-2x/shop#token}", "acme-2"],
            ["${vault:kv/eudiplo/instance/db#password}", "acme"],
            ["${env:OPERATOR_TOKEN}", "acme"],
            ["${env:ACME_TOKEN}", "other"],
        ];
        for (const [text, tenantId] of refused)
            expect(
                policy.refusal(reference(text), tenant(tenantId)),
                `${text} for ${tenantId}`,
            ).toMatch(/no grant of tenant/);
    });

    it("gives {tenant} namespaces only to tenant IDs of one path segment", () => {
        // Tenants from before 10.0 may have any ID. One that is no ID of
        // letters, digits, _ and - gets no grant of tenants["*"] at all.
        for (const tenantId of ["Upper", "a.b"])
            expect(
                policy.refusal(
                    reference(`\${vault:kv/eudiplo/tenants/${tenantId}/x#t}`),
                    tenant(tenantId),
                ),
                tenantId,
            ).toMatch(/no grant/);
        expect(
            policy.refusal(
                reference("${vault:kv/eudiplo/tenants/x/x#t}"),
                tenant("*"),
            ),
        ).toMatch(/no grant/);
        expect(
            policy.refusal(
                reference(SHARED_HUB),
                tenant("Upper", undefined, "https://hub.example"),
            ),
        ).toMatch(/no grant/);
        expect(
            policy.refusal(
                reference("${vault:kv/eudiplo/tenants/a_b-1/x#t}"),
                tenant("a_b-1"),
            ),
        ).toBeUndefined();
    });

    it("lets the instance name its namespaces but no setting of EUDIPLO", () => {
        const refusal = (text: string) =>
            policy.refusal(reference(text), instance());
        expect(refusal("${env:OPERATOR_TOKEN}")).toBeUndefined();
        // A prefix never covers a setting of EUDIPLO: it is named.
        expect(refusal("${env:VAULT_TOKEN}")).toBeUndefined();
        expect(refusal("${env:PUBLIC_URL}")).toMatch(/no grant/);
        expect(refusal("${env:MASTER_SECRET}")).toMatch(/setting of EUDIPLO/);
        expect(
            refusal("${vault:kv/eudiplo/instance/kms#token}"),
        ).toBeUndefined();
        expect(refusal("${vault:kv/eudiplo/tenants/acme/x#t}")).toMatch(
            /no grant of the instance/,
        );
    });

    it("lets a bound secret be used only in its fields and towards its origins", () => {
        const ref = reference(CSC);
        const at = (field: string, destination?: string) =>
            policy.refusal(ref, tenant("acme", field, destination));
        expect(
            at(
                "KmsConfig:providers.1.clientSecret",
                "https://csc.example.eu/oauth/token",
            ),
        ).toBeUndefined();
        expect(
            at("KmsConfig:providers.0.sad", "https://sad.example.eu/sign"),
        ).toBeUndefined();
        expect(
            at("WebhookEndpoint:auth.config.value", "https://csc.example.eu"),
        ).toBe(
            "tenant 'acme' may use it only in KmsConfig:providers.*.clientSecret, KmsConfig:providers.*.sad, not in WebhookEndpoint:auth.config.value",
        );
        expect(
            at(
                "KmsConfig:providers.1.clientSecret",
                "https://attacker.example/csc",
            ),
        ).toBe(
            "tenant 'acme' may send it only to https://csc.example.eu, not to https://attacker.example",
        );
        // The origins of one field's grant, not of another field's.
        expect(
            at("KmsConfig:providers.1.clientSecret", "https://sad.example.eu"),
        ).toMatch(/only to https:\/\/csc\.example\.eu,/);
        expect(
            at("KmsConfig:providers.1.clientSecret", "http://csc.example.eu"),
        ).toMatch(/only to/);
        expect(at("KmsConfig:providers.1.clientSecret", "not a url")).toMatch(
            /, not to this address$/,
        );
        expect(at("KmsConfig:providers.1.clientSecret")).toBe(
            "tenant 'acme' may send it only to https://csc.example.eu",
        );
        expect(
            policy.refusal(
                ref,
                tenant(
                    "acme-2",
                    "KmsConfig:providers.1.clientSecret",
                    "https://csc.example.eu",
                ),
            ),
        ).toMatch(/no grant of tenant 'acme-2'/);
    });

    it('applies bound grants of tenants["*"] and of the instance', () => {
        const hub = reference(SHARED_HUB);
        for (const tenantId of ["acme", "acme-2", "other"])
            expect(
                policy.refusal(
                    hub,
                    tenant(tenantId, undefined, "https://hub.example/hook"),
                ),
                tenantId,
            ).toBeUndefined();
        expect(
            policy.refusal(hub, tenant("acme", undefined, "https://x.example")),
        ).toMatch(/only to https:\/\/hub\.example/);
        expect(
            policy.refusal(reference("${env:VAULT_TOKEN}"), {
                ...instance(),
                destination: "https://vault.example",
            }),
        ).toBeUndefined();
        expect(
            issuesOf({
                tenants: {
                    acme: {
                        bound: [
                            {
                                ref: "${env:VAULT_TOKEN}",
                                fields: ["KmsConfig:providers.*.vaultToken"],
                                destinations: ["https://vault.example"],
                            },
                        ],
                    },
                },
            }),
        ).toEqual([
            "tenants.acme.bound.0.ref: VAULT_TOKEN is a setting of EUDIPLO itself, which only the instance can name",
        ]);
    });

    it("keeps the instance's bound grants from tenants", () => {
        expect(
            policy.refusal(
                reference("${env:VAULT_TOKEN}"),
                tenant(
                    "acme",
                    "KmsConfig:providers.0.vaultToken",
                    "https://vault.example",
                ),
            ),
        ).toMatch(/only the instance/);
    });

    it("refuses a tenant ID that gets no {tenant} namespace inside the template's region", () => {
        expect(
            issuesOf({
                tenants: {
                    "*": { vault: ["kv/eudiplo/tenants/{tenant}/"] },
                    Upper: { vault: ["kv/eudiplo/tenants/Upper/"] },
                },
            }),
        ).toEqual([
            "tenants.Upper.vault 'kv/eudiplo/tenants/Upper/' reaches into the namespaces of other tenants of tenants.*.vault 'kv/eudiplo/tenants/{tenant}/'",
        ]);
    });

    it("refuses ${required:…} and sources that are not configured", () => {
        expect(
            policy.refusal(
                reference("${required:WebhookEndpoint/shop/auth}"),
                tenant("acme"),
            ),
        ).toMatch(/must be supplied/);
        expect(
            SecretPolicy.create({}, [envSource({})]).refusal(
                reference("${vault:kv/a#t}"),
                tenant("acme"),
            ),
        ).toMatch(/not configured/);
    });

    it("lets nothing be named without grants", () => {
        const empty = SecretPolicy.empty(sources);
        expect(empty.refusal(reference("${env:ANY}"), tenant("acme"))).toMatch(
            /no grant/,
        );
        expect(empty.refusal(reference("${env:ANY}"), instance())).toMatch(
            /no grant/,
        );
    });

    it("refuses tenant namespaces that reach into another scope's secrets", () => {
        expect(
            issuesOf({
                instance: {
                    env: ["OPERATOR_*"],
                    vault: ["kv/eudiplo/instance/"],
                },
                tenants: {
                    "*": { vault: ["kv/eudiplo/tenants/{tenant}/"] },
                    acme: {
                        env: ["OP*", "CSC_*"],
                        vault: [
                            "kv/eudiplo/tenants/",
                            "kv/eudiplo/tenants/acme/own/",
                            "kv/eudiplo/",
                        ],
                    },
                    bob: {
                        bound: [
                            {
                                ref: "${env:CSC_SECRET}",
                                fields: ["KmsConfig:providers.*.clientSecret"],
                                destinations: ["https://csc.example.eu"],
                            },
                            {
                                ref: "${vault:kv/eudiplo/tenants/x/y#z}",
                                fields: ["KmsConfig:providers.*.clientSecret"],
                                destinations: ["https://csc.example.eu"],
                            },
                        ],
                    },
                    "UPPER-OLD": { vault: ["kv/other/"] },
                },
            }),
        ).toEqual([
            "tenants.acme.env 'OP*' reaches into instance.env 'OPERATOR_*', so a tenant could name secrets of the instance",
            "tenants.bob.bound: ${env:CSC_SECRET} lies inside tenants.acme.env 'CSC_*', where it could be sent anywhere; keep bound secrets out of tenant namespaces",
            "tenants.acme.vault 'kv/eudiplo/tenants/' reaches into the namespaces of other tenants of tenants.*.vault 'kv/eudiplo/tenants/{tenant}/'",
            "tenants.acme.vault 'kv/eudiplo/' reaches into the namespaces of other tenants of tenants.*.vault 'kv/eudiplo/tenants/{tenant}/'",
            "tenants.bob.bound: ${vault:kv/eudiplo/tenants/x/y#z} lies inside tenants.acme.vault 'kv/eudiplo/tenants/', where it could be sent anywhere; keep bound secrets out of tenant namespaces",
            "tenants.acme.vault 'kv/eudiplo/' reaches into instance.vault 'kv/eudiplo/instance/', so a tenant could name secrets of the instance",
            "tenants.bob.bound: ${vault:kv/eudiplo/tenants/x/y#z} lies inside tenants.acme.vault 'kv/eudiplo/', where it could be sent anywhere; keep bound secrets out of tenant namespaces",
            "tenants.bob.bound: ${vault:kv/eudiplo/tenants/x/y#z} lies inside tenants.*.vault 'kv/eudiplo/tenants/{tenant}/', where it could be sent anywhere; keep bound secrets out of tenant namespaces",
        ]);
    });

    it("reports every problem of a policy without repeating values", () => {
        expect(issuesOf(null)).toEqual([expect.stringMatching(/^\(root\): /)]);
        expect(issuesOf({ unknown: true })).toEqual([
            expect.stringMatching(/Unrecognized key/),
        ]);
        const issues = issuesOf({
            instance: { aws: ["x"] },
            tenants: {
                "*": {
                    env: ["SHARED_*", "T_{tenant}_*"],
                    vault: ["kv/shared/", "kv/t-{tenant}", "kv/{tenant}x/"],
                },
                acme: {
                    env: [
                        "ACME_*",
                        "lower",
                        "MASTER_SECRET",
                        "VAULT_TOKEN",
                        "*",
                    ],
                    vault: ["kv/t/{tenant}/"],
                    bound: [
                        {
                            ref: "hunter2-pasted-secret",
                            fields: ["KmsConfig:pin"],
                            destinations: ["https://a.example"],
                        },
                        {
                            ref: "${required:x}",
                            fields: ["KmsConfig:pin"],
                            destinations: ["https://a.example"],
                        },
                        {
                            ref: "${vault:kv/op/x#t}",
                            fields: ["no field", "KmsConfig:pin"],
                            destinations: [
                                "https://a.example/path",
                                "ftp://a.example",
                                "not a url",
                                "https://b.example/",
                            ],
                        },
                    ],
                },
                "acme-x": { env: ["ACME_X_*"] },
            },
        });
        expect(issues).toEqual([
            "instance.aws: unknown source; use one of env, vault or bound",
            "tenants.*.env: 'SHARED_*': would give every tenant the same secrets, and env has no {tenant} namespaces; grant it per tenant, or make it a bound grant",
            "tenants.*.env: 'T_{tenant}_*': names {tenant}, which only grants in tenants[\"*\"] of a source other than env can",
            "tenants.*.vault: 'kv/shared/': would give every tenant the same secrets; name {tenant} in it, or make it a bound grant",
            "tenants.*.vault: 'kv/t-{tenant}': needs a separator after {tenant}, such as /, that no tenant ID contains",
            "tenants.*.vault: 'kv/{tenant}x/': needs a separator after {tenant}, such as /, that no tenant ID contains",
            "tenants.acme.env: 'lower': an env grant is a variable name of A-Z, 0-9 and _, or a prefix of one ending in *",
            "tenants.acme.env: 'MASTER_SECRET': MASTER_SECRET is a setting of EUDIPLO itself, which no reference can name",
            "tenants.acme.env: 'VAULT_TOKEN': VAULT_TOKEN is a setting of EUDIPLO itself, which only the instance can name",
            "tenants.acme.env: '*': a tenant cannot be granted every variable; name a prefix",
            "tenants.acme.vault: 'kv/t/{tenant}/': names {tenant}, which only grants in tenants[\"*\"] can",
            "tenants.acme.bound.0.ref: is no secret reference",
            "tenants.acme.bound.1.ref: the source 'required' cannot be granted",
            "tenants.acme.bound.2.fields: 'no field' is no field; write <Kind>:<path>, for example KmsConfig:providers.*.clientSecret",
            "tenants.acme.bound.2.destinations: 'https://a.example/path' is no origin; write scheme, host and port only, for example https://csc.example.eu",
            "tenants.acme.bound.2.destinations: 'ftp://a.example' is no origin; write scheme, host and port only, for example https://csc.example.eu",
            "tenants.acme.bound.2.destinations: 'not a url' is no origin; write scheme, host and port only, for example https://csc.example.eu",
            "tenants.acme.env 'ACME_*' and tenants.acme-x.env 'ACME_X_*' overlap, so each tenant could name the other's secrets",
        ]);
        expect(issues.join()).not.toContain("hunter2");
    });
});
