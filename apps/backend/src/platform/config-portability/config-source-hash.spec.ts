import {
    CONFIG_FORMATS,
    schemaUrl,
} from "@eudiplo/config-format/config-format.js";
import { describe, expect, it } from "vitest";
import type { ConfigDocument } from "./config-resource.types.js";
import {
    documentAppliedAsIs,
    documentSourceHash,
} from "./config-source-hash.js";

describe("documentSourceHash", () => {
    // Earlier releases stored this hash. Another value makes every
    // file-managed key chain plan `update` once and get new keys.
    it("keeps the hash that earlier releases stored", () => {
        expect(
            documentSourceHash({
                $schema:
                    "https://eudiplo.dev/schemas/v1/KeyChainConfigFile.schema.json",
                kind: "KeyChain",
                metadata: { generation: 1 },
                spec: {
                    id: "issuer",
                    usageType: "attestation",
                    keySource: { type: "regenerate" },
                },
            }),
        ).toBe(
            "4991ae57c3a02ca473728646e5fe92fbcd13d41119a6afd2f9436d316087badc",
        );
    });
});

describe("documents applied as they are", () => {
    const keyChain: ConfigDocument = {
        $schema: schemaUrl("KeyChain"),
        kind: "KeyChain",
        metadata: { generation: 1 },
        spec: { id: "issuer", keySource: { type: "regenerate" } },
    };
    const client = (secret: string): ConfigDocument => ({
        $schema: schemaUrl("Client"),
        kind: "Client",
        metadata: { generation: 1 },
        spec: { clientId: "app", secret, roles: ["issuance:offer"] },
    });
    const applied = (
        document: ConfigDocument,
        overrides: Record<string, unknown> = {},
    ) => ({
        ownership: "file-managed" as const,
        source: "folder:/config/demo",
        sourceHash: documentSourceHash(document),
        ...overrides,
    });

    it("skips the comparison for the key chain or generated-secret client a source last applied", () => {
        for (const document of [keyChain, client("!generate")])
            expect(
                documentAppliedAsIs(
                    document,
                    applied(document),
                    "folder:/config/demo",
                ),
            ).toBe(true);
    });

    it("compares other documents, ownership and sources", () => {
        const withSecret = client("app-secret");
        expect(
            documentAppliedAsIs(
                withSecret,
                applied(withSecret),
                "folder:/config/demo",
            ),
        ).toBe(false);
        for (const ownership of ["detached", "unmanaged"])
            expect(
                documentAppliedAsIs(
                    keyChain,
                    applied(keyChain, { ownership }),
                    "folder:/config/demo",
                ),
            ).toBe(false);
        expect(
            documentAppliedAsIs(keyChain, applied(keyChain), "bundle:demo"),
        ).toBe(false);
        expect(
            documentAppliedAsIs(
                keyChain,
                applied(keyChain, { sourceHash: "other" }),
                "folder:/config/demo",
            ),
        ).toBe(false);
    });

    // 9.x stored these hashes over KeyChain v1 and Client v1 documents. After
    // the upgrade, the same files migrate to the current format, so only
    // their `$schema` differs from what 9.x hashed.
    it.each([
        {
            name: "a regenerate key chain",
            document: {
                $schema: schemaUrl("KeyChain"),
                kind: "KeyChain",
                metadata: { generation: 1 },
                spec: {
                    id: "issuer",
                    usageType: "attestation",
                    keySource: { type: "regenerate" },
                },
            } as ConfigDocument,
            sourceHash:
                "4991ae57c3a02ca473728646e5fe92fbcd13d41119a6afd2f9436d316087badc",
        },
        {
            name: "a !generate client",
            document: client("!generate"),
            sourceHash:
                "7e17b3df99de041fe3cc126ad269744b2c8cae8eec6587ae41119205ce77a3c4",
        },
    ])(
        "skips the comparison for $name that 9.x applied",
        ({ document, sourceHash }) => {
            // The pinned value is the v1 hash, not the current one.
            expect(sourceHash).not.toBe(documentSourceHash(document));
            expect(
                documentAppliedAsIs(
                    document,
                    applied(document, { sourceHash }),
                    "folder:/config/demo",
                ),
            ).toBe(true);
        },
    );

    // A later release with a new format version must still match what an
    // earlier one recorded under its own current version.
    it.each(
        [keyChain, client("!generate")].flatMap((document) =>
            Array.from(
                { length: CONFIG_FORMATS[document.kind].version },
                (_, index) => ({
                    document,
                    kind: document.kind,
                    version: index + 1,
                }),
            ),
        ),
    )(
        "skips the comparison for a $kind applied under v$version",
        ({ document, kind, version }) => {
            const sourceHash = documentSourceHash({
                ...document,
                $schema: schemaUrl(kind, version),
            });
            expect(
                documentAppliedAsIs(
                    document,
                    applied(document, { sourceHash }),
                    "folder:/config/demo",
                ),
            ).toBe(true);
        },
    );

    it("compares a document that changed since an earlier format version applied it", () => {
        const earlier = {
            ...client("!generate"),
            $schema: schemaUrl("Client", 1),
        };
        const changed: ConfigDocument = {
            ...client("!generate"),
            spec: {
                clientId: "app",
                secret: "!generate",
                roles: ["issuance:offer", "presentation:request"],
            },
        };
        expect(
            documentAppliedAsIs(
                changed,
                applied(changed, { sourceHash: documentSourceHash(earlier) }),
                "folder:/config/demo",
            ),
        ).toBe(false);
    });
});
