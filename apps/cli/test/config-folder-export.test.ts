import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
    type ConfigBundle,
    ConfigBundleCodec,
} from "@eudiplo/config-format/config-bundle.js";
import {
    type ConfigFile,
    type ConfigResourceKind,
    normalizeDocument,
    resourceId,
    schemaUrl,
} from "@eudiplo/config-format/config-format.js";
import { stableConfigJson } from "@eudiplo/config-format/config-values.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPortabilityCommand } from "../src/commands/config/portability/action.js";
import { packTenantFolder } from "../src/commands/config/portability/folder-bundle.js";
import type { CliConfig, CommandContext } from "../src/types.js";

const codec = new ConfigBundleCodec();
const config: CliConfig = {
    defaultInstance: "test",
    instances: { test: { target: "external", url: "https://example.test" } },
};
const logo = Buffer.from("png-bytes");

describe("config export --output <dir>", () => {
    let cwd: string;
    let output: { stdout: string; stderr: string };
    let context: CommandContext;
    let bundle: ConfigBundle;

    beforeEach(async () => {
        cwd = await mkdtemp(join(tmpdir(), "config-folder-export-"));
        output = { stdout: "", stderr: "" };
        bundle = exportedBundle();
        context = {
            cwd,
            env: { EUDIPLO_TOKEN: "test-token" },
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
                async () =>
                    new Response(new Uint8Array(codec.encode(bundle)), {
                        status: 200,
                    }),
            ),
        };
    });

    afterEach(async () => {
        await rm(cwd, { recursive: true, force: true });
    });

    const exportTo = (path: string) =>
        runPortabilityCommand(
            "export",
            config,
            { positionals: [], flags: { output: path } },
            context,
        );

    it("writes the tenant folder layout, named by resource ID", async () => {
        expect(await exportTo("acme")).toBe(0);

        expect(vi.mocked(context.fetch).mock.calls[0][0]).toBe(
            "https://example.test/api/config-bundles/export?format=zip",
        );
        expect(await tree(join(cwd, "acme"))).toEqual([
            "clients/portal.json",
            "images/logo.png",
            "info.json",
            "issuance/credentials/PID.json",
            "issuance/credentials/pid-ce71df4d.json",
            "issuance/credentials/pid_v1-368f06c1.json",
            "issuance/issuance.json",
            "key-chains/signing.json",
        ]);
        expect(await readFile(join(cwd, "acme", "images", "logo.png"))).toEqual(
            logo,
        );
    });

    it("keeps placeholders and required keys as exported, with sorted keys and a final newline", async () => {
        await exportTo("acme");

        const client = await readFile(
            join(cwd, "acme", "clients", "portal.json"),
            "utf8",
        );
        expect(client).toBe(
            `${JSON.stringify(
                {
                    $schema: schemaUrl("Client"),
                    metadata: { generation: 1, ownership: "unmanaged" },
                    spec: {
                        clientId: "portal",
                        roles: ["issuance:manage"],
                        secret: "${CLIENT_PORTAL_SECRET}",
                    },
                },
                null,
                2,
            )}\n`,
        );
        const keyChain = JSON.parse(
            await readFile(
                join(cwd, "acme", "key-chains", "signing.json"),
                "utf8",
            ),
        );
        expect(keyChain.spec.keySource).toEqual({
            type: "required",
            publicJwk: { crv: "P-256", kty: "EC", x: "x", y: "y" },
        });
    });

    it("lists what to supply before an import, by folder file", async () => {
        await exportTo("acme");

        expect(output.stdout).toContain(
            "Exported tenant acme to " +
                `${join(cwd, "acme")}: 7 files, 1 images`,
        );
        expect(output.stdout).toContain(
            "2 value(s) to supply before this folder can be imported:",
        );
        expect(output.stdout).toContain(
            "  clients/portal.json /spec/secret: ${CLIENT_PORTAL_SECRET} (CLIENT_SECRET_REQUIRED)",
        );
        expect(output.stdout).toContain(
            "  key-chains/signing.json /spec/keySource: private key (PRIVATE_KEY_REQUIRED)",
        );
        expect(output.stderr).toBe("");
    });

    it("round-trips: the folder packs back into the exported documents and assets", async () => {
        await exportTo("acme");

        const packed = await packTenantFolder(join(cwd, "acme"), {});
        const byKey = (documents: ConfigFile[]) =>
            Object.fromEntries(
                documents.map((document) => [
                    `${normalizeDocument(document).kind}/${resourceId(document)}`,
                    stableConfigJson(document),
                ]),
            );
        expect(byKey(packed.documents)).toEqual(byKey(bundle.documents));
        expect(packed.assets.map((asset) => asset.sha256)).toEqual(
            bundle.assets.map((asset) => asset.sha256),
        );
    });

    it("writes the same files however the server orders the keys", async () => {
        await exportTo("first");
        bundle = exportedBundle({ reverseKeys: true });
        await exportTo("second");

        const first = await contents(join(cwd, "first"));
        expect(await contents(join(cwd, "second"))).toEqual(first);
    });

    it("refuses a non-empty directory and leaves it untouched", async () => {
        await mkdir(join(cwd, "acme"));
        await writeFile(join(cwd, "acme", "keep.txt"), "mine");

        await expect(exportTo("acme")).rejects.toThrow(
            "Output directory is not empty",
        );
        expect(await tree(join(cwd, "acme"))).toEqual(["keep.txt"]);
        expect(
            (await readdir(cwd)).filter((name) => name.startsWith(".")),
        ).toEqual([]);
    });

    it("exports into an existing empty directory", async () => {
        await mkdir(join(cwd, "acme"));

        expect(await exportTo("acme")).toBe(0);
        expect(await tree(join(cwd, "acme"))).toContain("info.json");
    });

    it("notes when the folder is not named after the tenant", async () => {
        await exportTo("backup");

        expect(output.stderr).toContain(
            "the folder is not named after the tenant (acme)",
        );
    });

    it("still writes a single file for .zip and .json output", async () => {
        await exportTo("acme.zip");
        expect((await stat(join(cwd, "acme.zip"))).isFile()).toBe(true);
        expect(codec.decode(await readFile(join(cwd, "acme.zip")))).toEqual(
            codec.decode(codec.encode(bundle)),
        );
    });
});

function exportedBundle(options: { reverseKeys?: boolean } = {}): ConfigBundle {
    const order = (value: Record<string, unknown>) =>
        options.reverseKeys
            ? Object.fromEntries(Object.entries(value).reverse())
            : value;
    const document = (
        kind: ConfigResourceKind,
        spec: Record<string, unknown>,
        ownership = "file-managed",
    ): ConfigFile => ({
        $schema: schemaUrl(kind),
        metadata: { generation: 1, ownership } as ConfigFile["metadata"],
        spec: order(spec),
    });
    const documents = [
        document("Tenant", { name: "Acme", description: "Acme tenant" }),
        document(
            "Client",
            {
                secret: "${CLIENT_PORTAL_SECRET}",
                roles: ["issuance:manage"],
                clientId: "portal",
            },
            "unmanaged",
        ),
        document("KeyChain", {
            id: "signing",
            keySource: order({
                type: "required",
                publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
            }),
        }),
        document("IssuanceConfig", { display: [] }),
        document("CredentialConfig", { id: "pid", description: "lower" }),
        // Differs from "pid" only in case: a separate file on every system.
        document("CredentialConfig", { id: "PID", description: "upper" }),
        // Not a valid file name on Windows.
        document("CredentialConfig", { id: "pid:v1", description: "colon" }),
    ];
    const sha256 = (value: Buffer) =>
        createHash("sha256").update(value).digest("hex");
    return {
        manifest: {
            format: "eudiplo.config-bundle",
            formatVersion: 2,
            sourceVersion: "test",
            exportedAt: "2026-11-16T00:00:00.000Z",
            tenant: "acme",
            resources: documents.map((file) => {
                const { kind } = normalizeDocument(file);
                return {
                    kind,
                    id: resourceId(file),
                    $schema: file.$schema as string,
                    path: `${kind}/${resourceId(file).replace(":", "_")}.json`,
                    sha256: sha256(Buffer.from(JSON.stringify(file))),
                    ownership: "file-managed",
                    generation: 1,
                };
            }),
            assets: [
                {
                    path: "images/logo.png",
                    contentType: "image/png",
                    sha256: sha256(logo),
                },
            ],
            requirements: [
                {
                    code: "CLIENT_SECRET_REQUIRED",
                    resource: { kind: "Client", id: "portal" },
                    path: "/spec/secret",
                    placeholder: "CLIENT_PORTAL_SECRET",
                    message: "Client secrets are one-way hashed.",
                },
                {
                    code: "PRIVATE_KEY_REQUIRED",
                    resource: { kind: "KeyChain", id: "signing" },
                    path: "/spec/keySource",
                    message: "Supply the key material.",
                },
            ],
            warnings: [],
        },
        documents,
        assets: [
            {
                path: "images/logo.png",
                contentType: "image/png",
                sha256: sha256(logo),
                data: logo.toString("base64"),
            },
        ],
    };
}

async function tree(root: string): Promise<string[]> {
    const files: string[] = [];
    const walk = async (directory: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await walk(path);
            else files.push(relative(root, path).split("\\").join("/"));
        }
    };
    await walk(root);
    return files.sort((left, right) => {
        if (left < right) return -1;
        return left > right ? 1 : 0;
    });
}

async function contents(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const file of await tree(root))
        result[file] = (await readFile(join(root, file))).toString("base64");
    return result;
}
