import { createHash } from "node:crypto";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import type {
    ConfigBundle,
    ConfigResourceKind,
} from "../../src/platform/config-portability/config-resource.types.js";

/** A document of {@link documentsBundle}. */
export interface BundleDocument {
    kind: ConfigResourceKind;
    id: string;
    path: string;
    spec: Record<string, unknown>;
    generation?: number;
}

/**
 * A configuration bundle of `tenant` with unmanaged documents, as an export
 * would produce it.
 */
export function documentsBundle(
    tenant: string,
    entries: BundleDocument[],
): ConfigBundle {
    const documents = entries.map(({ kind, spec, generation = 1 }) => ({
        $schema: schemaUrl(kind),
        metadata: { generation },
        spec,
    }));
    return {
        manifest: {
            format: "eudiplo.config-bundle",
            formatVersion: 2,
            sourceVersion: "e2e",
            exportedAt: new Date(0).toISOString(),
            tenant,
            resources: entries.map(
                ({ kind, id, path, generation = 1 }, index) => ({
                    kind,
                    id,
                    $schema: documents[index].$schema,
                    path,
                    sha256: createHash("sha256")
                        .update(JSON.stringify(documents[index]))
                        .digest("hex"),
                    ownership: "unmanaged",
                    generation,
                }),
            ),
            assets: [],
            requirements: [],
            warnings: [],
        },
        documents,
        assets: [],
    } as ConfigBundle;
}

/**
 * A configuration bundle of `tenant` with one unmanaged document, as an
 * export would produce it.
 */
export function documentBundle(
    tenant: string,
    kind: ConfigResourceKind,
    id: string,
    path: string,
    spec: Record<string, unknown>,
    generation = 1,
): ConfigBundle {
    return documentsBundle(tenant, [{ kind, id, path, spec, generation }]);
}

/** A configuration bundle of `tenant` with one client. */
export function clientBundle(
    tenant: string,
    spec: Record<string, unknown> & { clientId: string },
): ConfigBundle {
    return documentBundle(
        tenant,
        "Client",
        spec.clientId,
        `clients/${spec.clientId}.json`,
        spec,
    );
}
