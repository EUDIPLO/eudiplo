import { createHash } from "node:crypto";
import * as fflate from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    assertConfigBundle,
    type ConfigBundle,
    ConfigBundleCodec,
    withoutRetiredResources,
} from "./config-bundle.js";
import { schemaUrl } from "./config-format.js";

function bundle(): ConfigBundle {
    const document = {
        $schema: schemaUrl("Tenant"),
        metadata: { generation: 1 },
        spec: { name: "Acme" },
    };
    return {
        manifest: {
            format: "eudiplo.config-bundle",
            formatVersion: 2,
            sourceVersion: "test",
            exportedAt: "2026-11-16T00:00:00.000Z",
            tenant: "acme",
            resources: [
                {
                    kind: "Tenant",
                    id: "tenant",
                    $schema: document.$schema,
                    path: "info.json",
                    sha256: createHash("sha256")
                        .update(JSON.stringify(document))
                        .digest("hex"),
                    ownership: "file-managed",
                    generation: 1,
                },
            ],
            assets: [],
            requirements: [],
            warnings: [],
        },
        documents: [document],
        assets: [],
    } as ConfigBundle;
}

describe("ConfigBundleCodec.encode", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("gives the same bytes for the same bundle, whenever it runs", () => {
        const codec = new ConfigBundleCodec();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-16T10:00:00Z"));
        const first = codec.encode(bundle());
        vi.setSystemTime(new Date("2027-03-01T23:59:58Z"));

        expect(codec.encode(bundle())).toEqual(first);
    });
});

/** The bundle with a registrar configuration as 9.x exported it. */
function bundleWithRegistrar(): ConfigBundle {
    const base = bundle();
    const registrar = {
        $schema: "https://eudiplo.dev/schemas/v2/RegistrarConfigFile.schema.json",
        spec: { registrarUrl: "https://registrar.example" },
    };
    return {
        ...base,
        manifest: {
            ...base.manifest,
            resources: [
                ...base.manifest.resources,
                {
                    kind: "RegistrarConfig",
                    id: "registrar",
                    $schema: registrar.$schema,
                    path: "registrar.json",
                    sha256: createHash("sha256")
                        .update(JSON.stringify(registrar))
                        .digest("hex"),
                    ownership: "file-managed",
                    generation: 1,
                } as unknown as ConfigBundle["manifest"]["resources"][number],
            ],
        },
        documents: [...base.documents, registrar],
    };
}

describe("resources of retired kinds", () => {
    it("are dropped from a bundle with a warning", () => {
        const input = bundleWithRegistrar();
        expect(() => assertConfigBundle(input)).toThrow();

        const result = withoutRetiredResources(input);

        expect(result.documents).toEqual(bundle().documents);
        expect(result.manifest.resources).toEqual(bundle().manifest.resources);
        expect(result.manifest.warnings).toEqual([
            expect.objectContaining({
                severity: "warning",
                code: "REGISTRAR_CONFIG_REMOVED",
            }),
        ]);
        expect(() => assertConfigBundle(result)).not.toThrow();
        // Applying it again changes nothing.
        expect(withoutRetiredResources(result)).toBe(result);
    });

    it("leave a bundle without them as it is", () => {
        const input = bundle();
        expect(withoutRetiredResources(input)).toBe(input);
    });

    it("are skipped when a ZIP is decoded", () => {
        const codec = new ConfigBundleCodec();
        const withRegistrar = bundleWithRegistrar();
        // The encoder only packs current kinds, so pack the registrar file
        // next to a current bundle by hand.
        const { unzipSync, zipSync, strToU8, strFromU8 } = fflate;
        const entries = unzipSync(new Uint8Array(codec.encode(bundle())));
        entries["registrar.json"] = strToU8(
            JSON.stringify(withRegistrar.documents[1]),
        );
        entries["manifest.json"] = strToU8(
            JSON.stringify(withRegistrar.manifest),
        );
        expect(strFromU8(entries["info.json"])).toBe(
            JSON.stringify(bundle().documents[0]),
        );

        const decoded = codec.decode(Buffer.from(zipSync(entries)));

        expect(decoded.documents).toEqual(bundle().documents);
        expect(decoded.manifest.resources.map((r) => r.path)).toEqual([
            "info.json",
        ]);
        expect(decoded.manifest.warnings).toEqual([
            expect.objectContaining({
                code: "REGISTRAR_CONFIG_REMOVED",
                message: expect.stringMatching(/^registrar\.json is skipped/),
            }),
        ]);
    });
});
