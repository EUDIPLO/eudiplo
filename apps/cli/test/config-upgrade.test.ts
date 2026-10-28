import { createHash } from "node:crypto";
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/runtime.js";
import type { CommandContext } from "../src/types.js";

const folders: string[] = [];
afterEach(async () => {
    await Promise.all(
        folders
            .splice(0)
            .map((folder) => rm(folder, { recursive: true, force: true })),
    );
});
async function setup() {
    const cwd = await mkdtemp(join(tmpdir(), "eudiplo-upgrade-"));
    folders.push(cwd);
    const output = { stdout: "", stderr: "" };
    const context: CommandContext = {
        cwd,
        env: {},
        stdout: {
            write: (text) => {
                output.stdout += String(text);
                return true;
            },
        },
        stderr: {
            write: (text) => {
                output.stderr += String(text);
                return true;
            },
        },
        fetch: vi.fn(() => {
            throw new Error("Upgrade must remain offline");
        }),
    };
    return { cwd, context, output };
}
const legacy = {
    $schema: schemaUrl("Tenant"),
    metadata: { generation: 4 },
    spec: { name: "Example" },
};
const hash = (value: string | Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
function bundle() {
    return {
        manifest: {
            format: "eudiplo.config-bundle",
            formatVersion: 1,
            tenant: "test",
            resources: [
                {
                    kind: "Tenant",
                    id: "tenant",
                    $schema: legacy.$schema,
                    path: "info.json",
                    sha256: hash(JSON.stringify(legacy)),
                },
            ],
            assets: [],
        },
        documents: [legacy],
        assets: [],
    };
}
describe("config upgrade", () => {
    it("keeps canonical documents unchanged offline", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "tenant.json");
        await writeFile(source, JSON.stringify(legacy));
        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        expect(
            JSON.parse(await readFile(`${source}.upgraded.json`, "utf8")),
        ).toEqual({
            $schema: schemaUrl("Tenant"),
            metadata: { generation: legacy.metadata.generation },
            spec: legacy.spec,
        });
        expect(JSON.parse(await readFile(source, "utf8"))).toEqual(legacy);
        expect(context.fetch).not.toHaveBeenCalled();
    });
    it("preserves canonical singleton manifest IDs", async () => {
        const { cwd, context } = await setup();
        const input = bundle();
        const source = join(cwd, "bundle.json");
        await writeFile(source, JSON.stringify(input));
        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const output = JSON.parse(
            await readFile(`${source}.upgraded.json`, "utf8"),
        );
        expect(output.manifest.resources[0].id).toBe("tenant");
        expect(output.documents[0].metadata).toEqual({ generation: 4 });
    });
    it("writes nothing for dry-run or invalid input", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "tenant.json");
        await writeFile(source, JSON.stringify(legacy));
        expect(
            await runCli(["config", "upgrade", source, "--dry-run"], context),
        ).toBe(0);
        await expect(access(`${source}.upgraded.json`)).rejects.toThrow();
        await writeFile(
            source,
            JSON.stringify({ ...legacy, spec: { name: 123 } }),
        );
        expect(await runCli(["config", "upgrade", source], context)).toBe(1);
        await expect(access(`${source}.upgraded.json`)).rejects.toThrow();
    });
    it("upgrades JSON bundle identifiers and checksums together", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "bundle.json");
        await writeFile(source, JSON.stringify(bundle()));
        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const result = JSON.parse(
            await readFile(`${source}.upgraded.json`, "utf8"),
        );
        expect(result.manifest.formatVersion).toBe(2);
        expect(result.manifest.resources[0].$schema).toBe(schemaUrl("Tenant"));
        expect(result.manifest.resources[0].apiVersion).toBeUndefined();
        expect(result.manifest.resources[0].sha256).toBe(
            hash(JSON.stringify(result.documents[0])),
        );
    });
    it("upgrades ZIP bundles and preserves assets", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "bundle.zip");
        await writeFile(
            source,
            zipSync({
                "manifest.json": strToU8(
                    JSON.stringify({
                        ...bundle().manifest,
                        assets: [
                            {
                                path: "images/logo.png",
                                sha256: hash("image"),
                                contentType: "image/png",
                            },
                        ],
                    }),
                ),
                "info.json": strToU8(JSON.stringify(legacy)),
                "images/logo.png": strToU8("image"),
            }),
        );
        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const result = unzipSync(await readFile(`${source}.upgraded.zip`));
        const manifest = JSON.parse(strFromU8(result["manifest.json"]));
        expect(manifest.formatVersion).toBe(2);
        expect(manifest.resources[0].sha256).toBe(hash(result["info.json"]));
        expect(JSON.parse(strFromU8(result["info.json"])).$schema).toBe(
            schemaUrl("Tenant"),
        );
        expect(strFromU8(result["images/logo.png"])).toBe("image");
    });
    it("refuses corrupt bundle checksums", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "bundle.json");
        const input = bundle();
        input.manifest.resources[0].sha256 = "invalid";
        await writeFile(source, JSON.stringify(input));
        expect(await runCli(["config", "upgrade", source], context)).toBe(1);
        await expect(access(`${source}.upgraded.json`)).rejects.toThrow();
    });
    it("checks and upgrades tenant folders without changing sources or dropping assets", async () => {
        const { cwd, context, output } = await setup();
        const source = join(cwd, "tenant-folder");
        await mkdir(join(source, "images"), { recursive: true });
        await writeFile(
            join(source, "info.json"),
            JSON.stringify({ name: "Example" }),
        );
        await writeFile(join(source, "images", "logo.png"), "image");
        expect(
            await runCli(
                ["config", "upgrade", source, "--check", "--diff"],
                context,
            ),
        ).toBe(1);
        expect(output.stdout).toContain("1 require upgrading");
        await expect(access(`${source}.upgraded`)).rejects.toThrow();
        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const result = JSON.parse(
            await readFile(join(`${source}.upgraded`, "info.json"), "utf8"),
        );
        expect(result).toMatchObject({
            $schema: schemaUrl("Tenant"),
            spec: { name: "Example" },
        });
        expect(
            await readFile(
                join(`${source}.upgraded`, "images", "logo.png"),
                "utf8",
            ),
        ).toBe("image");
        expect(
            await runCli(
                ["config", "upgrade", `${source}.upgraded`, "--check"],
                context,
            ),
        ).toBe(0);
        expect(await runCli(["config", "upgrade", source], context)).toBe(1);
        expect(
            JSON.parse(await readFile(join(source, "info.json"), "utf8")),
        ).toEqual({ name: "Example" });
    });
    it("upgrades a v1 client file to v2 with the spec unchanged", async () => {
        const { cwd, context, output } = await setup();
        const source = join(cwd, "client-folder");
        await mkdir(join(source, "clients"), { recursive: true });
        await writeFile(
            join(source, "info.json"),
            JSON.stringify({
                $schema: schemaUrl("Tenant"),
                metadata: { generation: 1 },
                spec: { name: "Example" },
            }),
        );
        const spec = { clientId: "shop-backend", roles: ["issuance:offer"] };
        await writeFile(
            join(source, "clients", "shop-backend.json"),
            JSON.stringify({ $schema: schemaUrl("Client", 1), spec }),
        );

        expect(
            await runCli(["config", "upgrade", source, "--check"], context),
        ).toBe(1);
        expect(output.stdout).toContain(
            "clients/shop-backend.json: upgrade required",
        );
        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const result = JSON.parse(
            await readFile(
                join(`${source}.upgraded`, "clients", "shop-backend.json"),
                "utf8",
            ),
        );
        expect(result.$schema).toBe(
            "https://eudiplo.dev/schemas/v2/ClientConfigFile.schema.json",
        );
        expect(result.spec).toEqual(spec);
    });
    it("upgrades a v4 issuance configuration to v5 and blocks an invalid federation entity id", async () => {
        const { cwd, context, output } = await setup();
        const source = join(cwd, "issuance.json");
        const spec = (entityId: string) => ({
            authorizationServers: [{ type: "built-in", id: "issuer" }],
            federation: {
                entityId,
                trustAnchors: [
                    {
                        entityId: "https://ta.example.org",
                        entityConfigurationUri:
                            "https://ta.example.org/.well-known/openid-federation",
                    },
                ],
            },
        });

        await writeFile(
            source,
            JSON.stringify({
                $schema: schemaUrl("IssuanceConfig", 4),
                spec: spec("issuer"),
            }),
        );
        expect(await runCli(["config", "upgrade", source], context)).toBe(1);
        expect(output.stderr).toContain(
            "/spec/federation/entityId: required-input FEDERATION_ENTITY_ID_INVALID",
        );
        await expect(access(`${source}.upgraded.json`)).rejects.toThrow();

        const valid = spec("https://eudiplo.example/issuers/tenant");
        await writeFile(
            source,
            JSON.stringify({
                $schema: schemaUrl("IssuanceConfig", 4),
                spec: valid,
            }),
        );
        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const result = JSON.parse(
            await readFile(`${source}.upgraded.json`, "utf8"),
        );
        expect(result.$schema).toBe(schemaUrl("IssuanceConfig", 5));
        expect(result.spec).toEqual(valid);
    });

    it("upgrades a v2 credential configuration to v3 without unsupported constraint keywords", async () => {
        const { cwd, context, output } = await setup();
        const source = join(cwd, "pid.json");
        const spec = (constraints: Record<string, unknown>) => ({
            id: "pid",
            config: { format: "dc+sd-jwt", display: [] },
            fields: [{ path: ["birth_date"], type: "string", constraints }],
        });
        await writeFile(
            source,
            JSON.stringify({
                $schema: schemaUrl("CredentialConfig", 2),
                spec: spec({
                    pattern: "^\\d{4}$",
                    widget: { formlyConfig: { template: "<b>x</b>" } },
                    items: { type: "string", widget: {} },
                }),
            }),
        );

        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        expect(output.stderr).toContain(
            "/spec/fields/0/constraints/widget: warning CLAIM_CONSTRAINT_KEYWORD_REMOVED",
        );
        expect(output.stderr).toContain(
            "/spec/fields/0/constraints/items/widget: warning CLAIM_CONSTRAINT_KEYWORD_REMOVED",
        );
        const upgraded = `${source}.upgraded.json`;
        const result = JSON.parse(await readFile(upgraded, "utf8"));
        expect(result.$schema).toBe(schemaUrl("CredentialConfig", 3));
        expect(result.spec).toEqual(
            spec({ pattern: "^\\d{4}$", items: { type: "string" } }),
        );
        expect(
            await runCli(["config", "upgrade", upgraded, "--check"], context),
        ).toBe(0);
    });

    it("upgrades a v1 KMS configuration file to v2 with the spec unchanged", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "kms-folder");
        await mkdir(source, { recursive: true });
        await writeFile(
            join(source, "info.json"),
            JSON.stringify({
                $schema: schemaUrl("Tenant"),
                metadata: { generation: 1 },
                spec: { name: "Example" },
            }),
        );
        const spec = { providers: [{ id: "db", type: "db" }] };
        await writeFile(
            join(source, "kms.json"),
            JSON.stringify({ $schema: schemaUrl("KmsConfig", 1), spec }),
        );

        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const result = JSON.parse(
            await readFile(join(`${source}.upgraded`, "kms.json"), "utf8"),
        );
        expect(result.$schema).toBe(
            "https://eudiplo.dev/schemas/v2/KmsConfigFile.schema.json",
        );
        expect(result.spec).toEqual(spec);
    });
    it("reads a bare KMS configuration file with provider algorithms as v2", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "bare-kms-folder");
        await mkdir(source, { recursive: true });
        await writeFile(
            join(source, "info.json"),
            JSON.stringify({
                $schema: schemaUrl("Tenant"),
                metadata: { generation: 1 },
                spec: { name: "Example" },
            }),
        );
        const spec = {
            providers: [{ id: "db", type: "db", algorithms: ["ES384"] }],
        };
        await writeFile(join(source, "kms.json"), JSON.stringify(spec));

        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const result = JSON.parse(
            await readFile(join(`${source}.upgraded`, "kms.json"), "utf8"),
        );
        expect(result.$schema).toBe(
            "https://eudiplo.dev/schemas/v2/KmsConfigFile.schema.json",
        );
        expect(result.spec).toEqual(spec);
    });
    it.each([
        ["a v1 registrar configuration file", 1],
        ["a bare registrar configuration file with a contact", undefined],
    ])("upgrades %s to v2 with the spec unchanged", async (_name, version) => {
        const { cwd, context } = await setup();
        const source = join(cwd, "registrar-folder");
        await mkdir(source, { recursive: true });
        await writeFile(
            join(source, "info.json"),
            JSON.stringify({
                $schema: schemaUrl("Tenant"),
                metadata: { generation: 1 },
                spec: { name: "Example" },
            }),
        );
        const spec: Record<string, unknown> = {
            registrarUrl: "https://registrar.example/api",
            oidcUrl: "https://auth.example/realms/registrar",
            clientId: "registrar-client",
            username: "verifier",
            password: "secret",
        };
        if (version === undefined)
            spec.relyingPartyContact = { email: "support@verifier.example" };
        await writeFile(
            join(source, "registrar.json"),
            JSON.stringify(
                version === undefined
                    ? spec
                    : { $schema: schemaUrl("RegistrarConfig", version), spec },
            ),
        );

        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const result = JSON.parse(
            await readFile(
                join(`${source}.upgraded`, "registrar.json"),
                "utf8",
            ),
        );
        expect(result.$schema).toBe(
            "https://eudiplo.dev/schemas/v2/RegistrarConfigFile.schema.json",
        );
        expect(result.spec).toEqual(spec);
    });
    it("upgrades a v1 tenant file to v4 with the spec unchanged", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "tenant-folder");
        await mkdir(source, { recursive: true });
        const spec = { name: "Example" };
        await writeFile(
            join(source, "info.json"),
            JSON.stringify({
                $schema: schemaUrl("Tenant", 1),
                metadata: { generation: 1 },
                spec,
            }),
        );

        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const result = JSON.parse(
            await readFile(join(`${source}.upgraded`, "info.json"), "utf8"),
        );
        expect(result.$schema).toBe(
            "https://eudiplo.dev/schemas/v4/TenantConfigFile.schema.json",
        );
        expect(result.spec).toEqual(spec);
    });
    it.each([
        ["a bare tenant file", { defaultKeyChains: { access: "access" } }],
        [
            "a v2 tenant file",
            {
                $schema: schemaUrl("Tenant", 2),
                metadata: { generation: 1 },
                spec: { name: "Example", defaultAccessKeyChainId: "access" },
            },
        ],
    ])(
        "drops the default key chains of %s with a warning",
        async (_name, file) => {
            const { cwd, context, output } = await setup();
            const source = join(cwd, "tenant-folder");
            await mkdir(source, { recursive: true });
            await writeFile(
                join(source, "info.json"),
                JSON.stringify(
                    "spec" in file ? file : { name: "Example", ...file },
                ),
            );

            expect(await runCli(["config", "upgrade", source], context)).toBe(
                0,
            );
            const result = JSON.parse(
                await readFile(join(`${source}.upgraded`, "info.json"), "utf8"),
            );
            expect(result.$schema).toBe(
                "https://eudiplo.dev/schemas/v4/TenantConfigFile.schema.json",
            );
            expect(result.spec).toEqual({ name: "Example" });
            expect(output.stderr).toContain(
                "/spec/defaultKeyChains: warning DEFAULT_KEY_CHAINS_MOVED",
            );
        },
    );
    it("upgrades a bare key chain defaults file", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "tenant-folder");
        await mkdir(source, { recursive: true });
        await writeFile(
            join(source, "key-chain-defaults.json"),
            JSON.stringify({ access: "access" }),
        );

        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        const result = JSON.parse(
            await readFile(
                join(`${source}.upgraded`, "key-chain-defaults.json"),
                "utf8",
            ),
        );
        expect(result).toEqual({
            $schema:
                "https://eudiplo.dev/schemas/v1/KeyChainDefaultsConfigFile.schema.json",
            metadata: { generation: 1 },
            spec: { access: "access" },
        });
    });
    it("validates the entire folder before writing any output", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "folder");
        await mkdir(join(source, "clients"), { recursive: true });
        await writeFile(
            join(source, "info.json"),
            JSON.stringify({ name: "Example" }),
        );
        await writeFile(
            join(source, "clients", "invalid.json"),
            JSON.stringify({ clientId: 123 }),
        );
        expect(await runCli(["config", "upgrade", source], context)).toBe(1);
        await expect(access(`${source}.upgraded`)).rejects.toThrow();
    });
    it("upgrades key chains without type to the current format", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "folder");
        await mkdir(join(source, "key-chains"), { recursive: true });
        const key = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" };
        const spec = { usageType: "attestation", key };
        await writeFile(
            join(source, "key-chains", "bare.json"),
            JSON.stringify({ id: "bare", ...spec }),
        );
        await writeFile(
            join(source, "key-chains", "enveloped.json"),
            JSON.stringify({
                $schema: schemaUrl("KeyChain", 1),
                metadata: { generation: 1 },
                spec: {
                    id: "enveloped",
                    usageType: "attestation",
                    keySource: { type: "private-jwk", jwk: key },
                },
            }),
        );
        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        for (const id of ["bare", "enveloped"]) {
            const result = JSON.parse(
                await readFile(
                    join(`${source}.upgraded`, "key-chains", `${id}.json`),
                    "utf8",
                ),
            );
            expect(result.$schema).toBe(schemaUrl("KeyChain"));
            expect(result.spec).not.toHaveProperty("type");
        }
    });
    it("upgrades a bare key chain export with type", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "folder");
        await mkdir(join(source, "key-chains"), { recursive: true });
        const key = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" };
        await writeFile(
            join(source, "key-chains", "issuer.json"),
            JSON.stringify({
                id: "issuer",
                usageType: "attestation",
                type: "internalChain",
                key,
            }),
        );
        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        expect(
            JSON.parse(
                await readFile(
                    join(`${source}.upgraded`, "key-chains", "issuer.json"),
                    "utf8",
                ),
            ),
        ).toMatchObject({
            $schema: schemaUrl("KeyChain"),
            spec: {
                type: "internalChain",
                keySource: { type: "private-jwk", jwk: key },
            },
        });
    });
    it("upgrades a bare federation key chain export to KeyChain v3", async () => {
        const { cwd, context } = await setup();
        const source = join(cwd, "folder");
        await mkdir(join(source, "key-chains"), { recursive: true });
        const key = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" };
        await writeFile(
            join(source, "key-chains", "federation.json"),
            JSON.stringify({
                id: "federation",
                usageType: "federation",
                type: "standalone",
                key,
            }),
        );
        expect(await runCli(["config", "upgrade", source], context)).toBe(0);
        expect(
            JSON.parse(
                await readFile(
                    join(`${source}.upgraded`, "key-chains", "federation.json"),
                    "utf8",
                ),
            ),
        ).toMatchObject({
            $schema: schemaUrl("KeyChain", 3),
            spec: { usageType: "federation", type: "standalone" },
        });
    });
    it("does not expose secrets in a legacy folder upgrade diff", async () => {
        const { cwd, context, output } = await setup();
        const source = join(cwd, "folder");
        await mkdir(join(source, "clients"), { recursive: true });
        await writeFile(
            join(source, "clients", "client.json"),
            JSON.stringify({
                clientId: "client",
                secret: "never-print-this",
                roles: ["clients:manage"],
            }),
        );
        expect(
            await runCli(
                ["config", "upgrade", source, "--check", "--diff"],
                context,
            ),
        ).toBe(1);
        expect(output.stdout).toContain("[redacted]");
        expect(output.stdout + output.stderr).not.toContain("never-print-this");
    });
});
