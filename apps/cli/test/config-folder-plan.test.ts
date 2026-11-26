import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ConfigBundle,
    ConfigBundleCodec,
} from "@eudiplo/config-format/config-bundle.js";
import { CONFIG_RESOURCE_KINDS } from "@eudiplo/config-format/config-format.js";
import {
    TENANT_FOLDER_RESOURCES,
    TENANT_FOLDER_TENANT,
    type TenantFolderResource,
} from "@eudiplo/config-format/tenant-folder.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPortabilityCommand } from "../src/commands/config/portability/action.js";
import { folderResources } from "../src/commands/config/portability/folder-bundle.js";
import { runCli } from "../src/runtime.js";
import type { CliConfig, CommandContext } from "../src/types.js";

const fingerprint = "b".repeat(64);
const config: CliConfig = {
    defaultInstance: "test",
    instances: { test: { target: "external", url: "https://example.test" } },
};
const plan = {
    applicable: true,
    planFingerprint: fingerprint,
    items: [
        {
            kind: "Client",
            id: "portal",
            action: "update",
            changes: [{ path: "/spec/description", before: "a", after: "b" }],
        },
    ],
    issues: [],
    assets: [{ path: "images/logo.png", action: "create" }],
};

describe("config plan / import with a tenant folder", () => {
    let cwd: string;
    let tenant: string;
    let output: { stdout: string; stderr: string };
    let context: CommandContext;

    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), "config-folder-plan-"));
        tenant = join(cwd, "acme");
        output = { stdout: "", stderr: "" };
        context = {
            cwd,
            env: {
                EUDIPLO_TOKEN: "test-token",
                PORTAL_SECRET: "s3cr3t-value",
            },
            stdout: {
                write: (chunk: string) => {
                    output.stdout += chunk;
                    return true;
                },
            },
            stderr: {
                write: (chunk: string) => {
                    output.stderr += chunk;
                    return true;
                },
            },
            fetch: vi.fn(
                async () => new Response(JSON.stringify(plan), { status: 200 }),
            ),
        };
        await writeJson(join(tenant, "info.json"), { name: "Acme" });
        // A bare file without envelope, as written by hand or by older exports.
        await writeJson(join(tenant, "clients", "portal.json"), {
            clientId: "portal",
            secret: "${PORTAL_SECRET}",
            roles: ["issuance:manage"],
        });
        await mkdir(join(tenant, "images"));
        await writeFile(join(tenant, "images", "logo.png"), "png-bytes");
        await writeFile(join(tenant, "images", ".gitkeep"), "");
        await writeFile(join(tenant, "images", ".DS_Store"), "finder");
    });

    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });

    it("prints the validation warnings of the folder and leaves registrar.json out", async () => {
        await writeJson(join(tenant, "registrar.json"), {
            registrarUrl: "https://registrar.example/api",
        });

        const code = await runPortabilityCommand(
            "plan",
            config,
            {
                positionals: ["acme"],
                flags: { "allow-env": "PORTAL_SECRET" },
            },
            context,
        );

        expect(code).toBe(0);
        expect(output.stderr).toContain(
            "registrar.json: registrar.json is skipped",
        );
        const [, init] = bundleCalls(context)[0];
        const bundle = await sentBundle(init);
        expect(bundle.manifest.resources.map((r) => r.path)).not.toContain(
            "registrar.json",
        );
    });

    it("packs the folder into a ZIP bundle and plans it", async () => {
        const code = await runPortabilityCommand(
            "plan",
            config,
            {
                positionals: ["acme"],
                flags: { "allow-env": "PORTAL_SECRET" },
            },
            context,
        );

        expect(code).toBe(0);
        const [url, init] = bundleCalls(context)[0];
        expect(url).toBe(
            "https://example.test/api/config-bundles/plan/archive?mode=upsert",
        );
        const bundle = await sentBundle(init);
        expect(bundle.manifest.tenant).toBe("acme");
        expect(
            bundle.manifest.resources.map((r) => `${r.kind}:${r.id}:${r.path}`),
        ).toEqual([
            "Tenant:tenant:info.json",
            "Client:portal:clients/portal.json",
        ]);
        expect(bundle.documents[1].spec).toMatchObject({
            clientId: "portal",
            secret: "s3cr3t-value",
        });
        expect(bundle.assets.map((asset) => asset.path)).toEqual([
            "images/logo.png",
        ]);
        expect(bundle.assets[0].contentType).toBe("image/png");
        // JSON stays the default plan output.
        expect(JSON.parse(output.stdout).planFingerprint).toBe(fingerprint);
    });

    it("sends the same bundle to plan and import, so the fingerprint matches", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            await runPortabilityCommand(
                "plan",
                config,
                {
                    positionals: ["acme"],
                    flags: {
                        output: "plan.json",
                        "allow-env": "PORTAL_SECRET",
                    },
                },
                context,
            );
            // An import runs later than the plan it applies.
            vi.setSystemTime(Date.now() + 60 * 60 * 1000);
            await runPortabilityCommand(
                "import",
                config,
                {
                    positionals: ["acme"],
                    flags: { plan: "plan.json", "allow-env": "PORTAL_SECRET" },
                },
                context,
            );
        } finally {
            vi.useRealTimers();
        }

        const calls = bundleCalls(context);
        expect(calls[1][0]).toBe(
            `https://example.test/api/config-bundles/import/archive?mode=upsert&planFingerprint=${fingerprint}`,
        );
        // Equal bytes, not only equal content: the codec pins the ZIP time.
        expect(await sentZip(calls[1][1])).toEqual(await sentZip(calls[0][1]));
        const planned = await sentBundle(calls[0][1]);
        expect(planned.manifest.exportedAt).toBe("1970-01-01T00:00:00.000Z");
        expect(await sentBundle(calls[1][1])).toEqual(planned);
    });

    it("maps every folder file to its bundle path, in a fixed order", async () => {
        await writeJson(join(tenant, "clients", "b.json"), {
            clientId: "b",
            roles: ["issuance:manage"],
        });
        await writeJson(join(tenant, "clients", "a.json"), {
            clientId: "a",
            roles: ["issuance:manage"],
        });
        await writeJson(join(tenant, "issuance", "issuance.json"), {
            authorizationServers: [{ id: "as", type: "built-in" }],
        });
        await writeJson(join(tenant, "key-chain-defaults.json"), {});
        // An image whose name starts with a dot is an asset, as at startup.
        await writeFile(join(tenant, "images", ".hidden.png"), "png-bytes");

        const code = await runPortabilityCommand(
            "plan",
            config,
            {
                positionals: ["acme"],
                flags: { "allow-env": "PORTAL_SECRET" },
            },
            context,
        );

        expect(code).toBe(0);
        const bundle = await sentBundle(bundleCalls(context)[0][1]);
        expect(
            bundle.manifest.resources.map((r) => `${r.kind}:${r.path}`),
        ).toEqual([
            "Tenant:info.json",
            "KeyChainDefaults:key-chain-defaults.json",
            "Client:clients/a.json",
            "Client:clients/b.json",
            "Client:clients/portal.json",
            "IssuanceConfig:issuance/config.json",
        ]);
        expect(bundle.assets.map((asset) => asset.path)).toEqual([
            "images/.hidden.png",
            "images/logo.png",
        ]);
    });

    it("uses the folder layout the backend's startup import reads", () => {
        const where = (resources: readonly TenantFolderResource[]) =>
            Object.fromEntries(
                resources.map((resource) => [
                    resource.kind,
                    "file" in resource
                        ? `${resource.file} -> ${resource.bundlePath}`
                        : `${resource.directory}/`,
                ]),
            );
        expect(where(folderResources())).toEqual(
            where([TENANT_FOLDER_TENANT, ...TENANT_FOLDER_RESOURCES]),
        );
    });

    it("knows a folder location for every resource kind", () => {
        expect(
            [
                ...new Set(folderResources().map((resource) => resource.kind)),
            ].sort(),
        ).toEqual([...CONFIG_RESOURCE_KINDS].sort());
    });

    it("does not repeat the content of a file that is not valid JSON", async () => {
        await writeFile(
            join(tenant, "clients", "broken.json"),
            // Short enough that a JSON.parse message would quote all of it.
            '{"s":"leak" x}',
        );

        const code = await runPortabilityCommand(
            "plan",
            config,
            {
                positionals: ["acme"],
                flags: { format: "text", "allow-env": "PORTAL_SECRET" },
            },
            context,
        );

        expect(code).toBe(1);
        expect(output.stderr).toContain("clients/broken.json");
        expect(output.stderr).toContain("Invalid JSON");
        expect(output.stderr).toMatch(/Invalid JSON\s*$/m);
        expect(output.stderr).not.toContain("leak");
    });

    it("validates the folder offline and never contacts the server when it is invalid", async () => {
        await writeJson(join(tenant, "clients", "broken.json"), {
            clientId: "broken",
            roles: "not-a-list",
        });

        const code = await runPortabilityCommand(
            "plan",
            config,
            {
                positionals: ["acme"],
                flags: { format: "text", "allow-env": "PORTAL_SECRET" },
            },
            context,
        );

        expect(code).toBe(1);
        expect(context.fetch).not.toHaveBeenCalled();
        expect(output.stderr).toContain("FAIL acme");
        expect(output.stderr).toContain("clients/broken.json");
        expect(output.stderr).toContain(
            "Not sent to https://example.test: fix the configuration folder first.",
        );
    });

    it("sends the folder as a file: the escaped form stays and a filled-in value is escaped", async () => {
        context.env.PORTAL_SECRET = "pa${NOT_A_PLACEHOLDER}ss";
        await writeJson(join(tenant, "clients", "portal.json"), {
            clientId: "portal",
            secret: "${PORTAL_SECRET}",
            // Text an export wrote in its escaped form.
            description: "Portal $${PORTAL_SECRET}",
            roles: ["issuance:manage"],
        });

        const code = await runPortabilityCommand(
            "plan",
            config,
            {
                positionals: ["acme"],
                flags: { "allow-env": "PORTAL_SECRET" },
            },
            context,
        );

        expect(code).toBe(0);
        const bundle = await sentBundle(bundleCalls(context)[0][1]);
        // The API reads `$${` as `${`, so neither value is a placeholder there.
        expect(bundle.documents[1].spec).toMatchObject({
            secret: "pa$${NOT_A_PLACEHOLDER}ss",
            description: "Portal $${PORTAL_SECRET}",
        });
    });

    it("sends a kms.json without an escaped form: $${ is a $ and the value, which is not escaped", async () => {
        context.env.VAULT_TOKEN = "hvs.${NOT_A_PLACEHOLDER}";
        await writeJson(join(tenant, "kms.json"), {
            providers: [
                {
                    id: "vault",
                    type: "vault",
                    vaultUrl: "https://vault.example",
                    vaultToken: "$${VAULT_TOKEN}",
                },
            ],
        });

        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: { "allow-env": "VAULT_TOKEN" } },
            context,
        );

        expect(code).toBe(0);
        const bundle = await sentBundle(bundleCalls(context)[0][1]);
        const kms = bundle.documents.find((document) =>
            String(document.$schema).includes("KmsConfigFile"),
        );
        expect(kms?.spec).toMatchObject({
            providers: [{ vaultToken: "$hvs.${NOT_A_PLACEHOLDER}" }],
        });
    });

    it("refuses --allow-env for a bundle file, whose placeholders the CLI does not fill in", async () => {
        await writeFile(join(cwd, "bundle.json"), "{}");

        await expect(
            runPortabilityCommand(
                "plan",
                config,
                {
                    positionals: ["bundle.json"],
                    flags: { "allow-env": "PORTAL_SECRET" },
                },
                context,
            ),
        ).rejects.toThrow(
            "--allow-env applies to a tenant folder only; replace the placeholders of a bundle with their values.",
        );
        expect(context.fetch).not.toHaveBeenCalled();
    });

    it("warns before sending a folder to a backend that predates the escaped form", async () => {
        vi.mocked(context.fetch).mockImplementation(async (url) =>
            String(url).endsWith("/api/version")
                ? new Response(JSON.stringify({ version: "10.1.0" }))
                : new Response(JSON.stringify(plan)),
        );

        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: { "allow-env": "PORTAL_SECRET" } },
            context,
        );

        expect(code).toBe(0);
        expect(vi.mocked(context.fetch).mock.calls[0][0]).toBe(
            "https://example.test/api/version",
        );
        expect(output.stderr).toContain(
            "the backend (10.1.0) does not read the escaped form $${ of configuration files",
        );
        expect(output.stderr).toContain(
            "Upgrade the CLI and the backend together.",
        );
    });

    it.each([
        ["a later release", { version: "10.1.1" }, 200],
        ["a development build", { version: "main" }, 200],
        ["an unreadable version", {}, 500],
    ])("does not warn for %s", async (_name, body, status) => {
        vi.mocked(context.fetch).mockImplementation(async (url) =>
            String(url).endsWith("/api/version")
                ? new Response(JSON.stringify(body), { status })
                : new Response(JSON.stringify(plan)),
        );

        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: { "allow-env": "PORTAL_SECRET" } },
            context,
        );

        expect(code).toBe(0);
        expect(output.stderr).not.toContain("escaped form");
    });

    it("does not warn when the version request fails, and still sends the folder", async () => {
        vi.mocked(context.fetch).mockImplementation(async (url) => {
            if (String(url).endsWith("/api/version"))
                throw new TypeError("fetch failed");
            return new Response(JSON.stringify(plan));
        });

        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: { "allow-env": "PORTAL_SECRET" } },
            context,
        );

        expect(code).toBe(0);
        expect(bundleCalls(context)).toHaveLength(1);
        expect(output.stderr).not.toContain("escaped form");
    });

    it("warns before an import stores anything", async () => {
        vi.mocked(context.fetch).mockImplementation(async (url) =>
            String(url).endsWith("/api/version")
                ? new Response(JSON.stringify({ version: "10.1.0" }))
                : new Response(JSON.stringify(plan)),
        );

        await runPortabilityCommand(
            "import",
            config,
            {
                positionals: ["acme"],
                flags: {
                    "plan-fingerprint": fingerprint,
                    "allow-env": "PORTAL_SECRET",
                },
            },
            context,
        );

        const calls = vi.mocked(context.fetch).mock.calls;
        expect(calls[0][0]).toBe("https://example.test/api/version");
        expect(String(calls[1][0])).toContain(
            "/api/config-bundles/import/archive",
        );
        expect(output.stderr).toContain("the backend (10.1.0)");
    });

    it("leaves the CONFIG_FOLDER variable rules to tenant validate: the CLI fills the folder", async () => {
        await writeJson(join(tenant, "info.json"), {
            name: "${AWS_SESSION_TOKEN}",
        });

        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: {} },
            context,
        );

        expect(code).toBe(0);
        expect(bundleCalls(context)).toHaveLength(1);
        expect(output.stderr).toContain("SECRET_REQUIRED");
        expect(output.stderr).not.toContain("holds the AWS credentials");
    });

    it("masks a filled-in value that contains ${, also in its escaped form", async () => {
        context.env.PORTAL_SECRET = "pa${NOT_A_PLACEHOLDER}ss";
        const leaky = {
            ...plan,
            items: [
                {
                    kind: "Client",
                    id: "portal",
                    action: "update",
                    changes: [
                        {
                            path: "/spec/description",
                            before: "Stored pa$${NOT_A_PLACEHOLDER}ss",
                            after: "Now pa${NOT_A_PLACEHOLDER}ss",
                        },
                    ],
                },
            ],
        };
        vi.mocked(context.fetch).mockImplementation(
            async () => new Response(JSON.stringify(leaky), { status: 200 }),
        );

        await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: { "allow-env": "PORTAL_SECRET" } },
            context,
        );

        const [change] = JSON.parse(output.stdout).items[0].changes;
        expect(change.before).toBe("Stored ${PORTAL_SECRET}");
        expect(change.after).toBe("Now ${PORTAL_SECRET}");
    });

    it("keeps a placeholder that --allow-env does not name for the server, without its value", async () => {
        // PORTAL_SECRET is set, but the folder may not read it.
        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: {} },
            context,
        );

        // An exported folder keeps its placeholders; the server's plan blocks
        // that resource with SECRET_REQUIRED, so the CLI does not stop here.
        expect(code).toBe(0);
        expect(output.stderr).toContain(
            "clients/portal.json /secret: Unresolved placeholder ${PORTAL_SECRET}",
        );
        expect(output.stderr).toContain("SECRET_REQUIRED");
        const bundle = await sentBundle(bundleCalls(context)[0][1]);
        expect(bundle.documents[1].spec).toMatchObject({
            secret: "${PORTAL_SECRET}",
        });
        expect(output.stderr).toContain("--allow-env");
        expect(output.stderr).not.toContain("s3cr3t-value");
    });

    it("refuses the CLI's own credentials in --allow-env", async () => {
        await expect(
            runPortabilityCommand(
                "plan",
                config,
                {
                    positionals: ["acme"],
                    flags: { "allow-env": "PORTAL_SECRET,EUDIPLO_TOKEN" },
                },
                context,
            ),
        ).rejects.toThrow("EUDIPLO_TOKEN holds the CLI's own credentials");
        expect(context.fetch).not.toHaveBeenCalled();
    });

    it.each([
        ["a linked images directory", "images", true],
        ["a linked document", "info.json", false],
    ])(
        "refuses %s that points outside the folder",
        async (_, name, isDirectory) => {
            const outside = join(cwd, "outside");
            await mkdir(outside);
            await writeFile(join(outside, "id_rsa"), "private-key");
            await writeJson(join(outside, "info.json"), { name: "Elsewhere" });
            await rm(join(tenant, name), { recursive: true });
            await symlink(
                isDirectory ? outside : join(outside, name),
                join(tenant, name),
            );

            await expect(
                runPortabilityCommand(
                    "plan",
                    config,
                    {
                        positionals: ["acme"],
                        flags: { "allow-env": "PORTAL_SECRET" },
                    },
                    context,
                ),
            ).rejects.toThrow(
                `${name}: symbolic link points outside the configuration folder`,
            );
            expect(context.fetch).not.toHaveBeenCalled();
        },
    );

    it("accepts a symbolic link that stays inside the folder", async () => {
        await mkdir(join(tenant, "shared"));
        await writeFile(join(tenant, "shared", "brand.png"), "png-bytes");
        await symlink(
            join(tenant, "shared", "brand.png"),
            join(tenant, "images", "brand.png"),
        );

        const code = await runPortabilityCommand(
            "plan",
            config,
            {
                positionals: ["acme"],
                flags: { "allow-env": "PORTAL_SECRET" },
            },
            context,
        );

        expect(code).toBe(0);
        expect(bundleCalls(context)).toHaveLength(1);
    });

    it("never fills in the CLI's own EUDIPLO_* variables", async () => {
        await writeJson(join(tenant, "clients", "portal.json"), {
            clientId: "portal",
            secret: "${EUDIPLO_TOKEN}",
            roles: ["issuance:manage"],
        });

        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: {} },
            context,
        );

        expect(code).toBe(0);
        const bundle = await sentBundle(bundleCalls(context)[0][1]);
        expect(bundle.documents[1].spec).toMatchObject({
            secret: "${EUDIPLO_TOKEN}",
        });
        expect(output.stderr).toContain("(not named in --allow-env)");
        expect(output.stdout + output.stderr).not.toContain("test-token");
    });

    it("shows filled-in values as their placeholder in the printed and saved plan", async () => {
        const leaky = {
            ...plan,
            items: [
                {
                    kind: "Client",
                    id: "portal",
                    action: "update",
                    changes: [
                        {
                            path: "/spec/description",
                            before: "old",
                            after: "Secret is s3cr3t-value here",
                        },
                    ],
                },
            ],
        };
        vi.mocked(context.fetch).mockImplementation(
            async () => new Response(JSON.stringify(leaky), { status: 200 }),
        );

        for (const flags of [
            { diff: true, "allow-env": "PORTAL_SECRET" },
            { output: "plan.json", "allow-env": "PORTAL_SECRET" },
        ]) {
            output.stdout = "";
            await runPortabilityCommand(
                "plan",
                config,
                { positionals: ["acme"], flags },
                context,
            );
            expect(output.stdout).not.toContain("s3cr3t-value");
            expect(output.stdout).toContain("Secret is ${PORTAL_SECRET} here");
        }
        const saved = await readFile(join(cwd, "plan.json"), "utf8");
        expect(saved).not.toContain("s3cr3t-value");
        expect(JSON.parse(saved).planFingerprint).toBe(fingerprint);
    });

    it("never masks inside the plan fingerprint", async () => {
        context.env.PORTAL_SECRET = "bbbbbbbbbbbb";

        await runPortabilityCommand(
            "plan",
            config,
            {
                positionals: ["acme"],
                flags: { output: "plan.json", "allow-env": "PORTAL_SECRET" },
            },
            context,
        );

        const saved = JSON.parse(
            await readFile(join(cwd, "plan.json"), "utf8"),
        );
        expect(saved.planFingerprint).toBe(fingerprint);
    });

    it("shows filled-in values as their placeholder in an API error", async () => {
        vi.mocked(context.fetch).mockImplementation(
            async () =>
                new Response("secret s3cr3t-value is too short", {
                    status: 400,
                }),
        );

        await expect(
            runPortabilityCommand(
                "plan",
                config,
                {
                    positionals: ["acme"],
                    flags: { "allow-env": "PORTAL_SECRET" },
                },
                context,
            ),
        ).rejects.toThrow(
            "EUDIPLO API returned 400: secret ${PORTAL_SECRET} is too short",
        );
    });

    it("writes the validation report as JSON with --format json", async () => {
        await rm(join(tenant, "info.json"));

        const code = await runPortabilityCommand(
            "plan",
            config,
            { positionals: ["acme"], flags: { format: "json" } },
            context,
        );

        expect(code).toBe(1);
        expect(context.fetch).not.toHaveBeenCalled();
        const report = JSON.parse(output.stdout);
        expect(report.valid).toBe(false);
        expect(report.tenants[0].errors[0].file).toBe("info.json");
    });

    it("renders a readable plan with --format text and keeps --diff as its alias", async () => {
        for (const flags of [
            { format: "text", "allow-env": "PORTAL_SECRET" },
            { diff: true, "allow-env": "PORTAL_SECRET" },
        ]) {
            output.stdout = "";
            await runPortabilityCommand(
                "plan",
                config,
                { positionals: ["acme"], flags },
                context,
            );
            expect(output.stdout).toContain("Client/portal: update");
            expect(output.stdout).toContain('  /spec/description: "a" -> "b"');
            expect(output.stdout).toContain("images/logo.png: create");
            expect(output.stdout).toContain(`Plan fingerprint: ${fingerprint}`);
        }
    });

    it("refuses --diff together with --format json", async () => {
        await expect(
            runPortabilityCommand(
                "plan",
                config,
                {
                    positionals: ["acme"],
                    flags: { diff: true, format: "json" },
                },
                context,
            ),
        ).rejects.toThrow("either --diff or --format json");
        expect(context.fetch).not.toHaveBeenCalled();
    });

    it("takes --allow-env from the command line", async () => {
        // Its own CLI config, not the one in the home directory.
        const cliConfig = join(cwd, "cli-config.json");
        await writeJson(cliConfig, config);
        context.env.EUDIPLO_CLI_CONFIG = cliConfig;

        const code = await runCli(
            ["config", "plan", "acme", "--allow-env", "PORTAL_SECRET"],
            context,
        );

        expect(code).toBe(0);
        const bundle = await sentBundle(bundleCalls(context)[0][1]);
        expect(bundle.documents[1].spec).toMatchObject({
            secret: "s3cr3t-value",
        });
    });

    it("rejects an unknown --format through the command line", async () => {
        const code = await runCli(
            ["config", "plan", "acme", "--format", "yaml"],
            context,
        );

        expect(code).not.toBe(0);
        expect(output.stderr).toContain("yaml");
        expect(context.fetch).not.toHaveBeenCalled();
    });

    it("fails clearly when the bundle or folder does not exist", async () => {
        await expect(
            runPortabilityCommand(
                "plan",
                config,
                { positionals: ["missing"], flags: {} },
                context,
            ),
        ).rejects.toThrow("Bundle or folder not found");
    });
});

async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function sentZip(init: RequestInit | undefined): Promise<Buffer> {
    const file = (init?.body as FormData).get("bundle") as Blob;
    return Buffer.from(await file.arrayBuffer());
}

async function sentBundle(
    init: RequestInit | undefined,
): Promise<ConfigBundle> {
    return new ConfigBundleCodec().decode(await sentZip(init));
}

/** The calls to the config-bundles API, without the version request. */
function bundleCalls(context: CommandContext) {
    return vi
        .mocked(context.fetch)
        .mock.calls.filter(([url]) => !String(url).endsWith("/api/version"));
}
