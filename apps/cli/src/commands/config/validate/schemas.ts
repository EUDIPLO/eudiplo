import { readCliTextAsset, templateAssetUrl } from "../../../sea-assets.js";
import { requiredSchemaFiles } from "./registry.js";

const manifestAssetKey = "templates/schemas.manifest.json";

export async function loadTenantConfigSchemas(): Promise<
    Map<string, Record<string, unknown>>
> {
    const schemaTexts = await loadBundledConfigSchemaTexts();
    return new Map(
        Array.from(schemaTexts, ([schemaFile, text]) => [
            schemaFile,
            JSON.parse(text),
        ]),
    );
}

export async function loadBundledConfigSchemaTexts(): Promise<
    Map<string, string>
> {
    const manifest = await readSchemaManifest();
    const schemas = new Map<string, string>();

    const required = requiredSchemaFiles();
    for (const schemaFile of required) {
        if (!manifest.includes(schemaFile)) {
            throw new Error(
                `Bundled schema manifest is missing "${schemaFile}". Run "pnpm --filter @eudiplo/cli assets:sync".`,
            );
        }
    }

    for (const schemaFile of manifest) {
        const text = await readCliTextAsset(
            `templates/schemas/${schemaFile}`,
            () => templateAssetUrl(`schemas/${schemaFile}`),
        );
        schemas.set(schemaFile, text);
    }

    return schemas;
}

async function readSchemaManifest(): Promise<string[]> {
    const text = await readCliTextAsset(manifestAssetKey, () =>
        templateAssetUrl("schemas.manifest.json"),
    );
    const parsed = JSON.parse(text);
    if (
        !Array.isArray(parsed) ||
        !parsed.every((item) => typeof item === "string")
    ) {
        throw new Error("Bundled schema manifest is malformed.");
    }
    return parsed;
}
