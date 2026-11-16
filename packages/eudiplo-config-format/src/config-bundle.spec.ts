import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConfigBundle, ConfigBundleCodec } from "./config-bundle.js";
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
