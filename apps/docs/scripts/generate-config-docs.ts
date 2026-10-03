import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promises as fs } from "node:fs";
import Joi from "joi";
import { buildModelFromSchema } from "./config-docs/model";
import { VALIDATION_SCHEMA } from "../../backend/src/platform/config/combined.schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_GENERATED_DIR = resolve(__dirname, "../docs/_generated");
const MODEL_FILE = resolve(DOCS_GENERATED_DIR, "config-model.json");

async function main() {
    const model = buildModelFromSchema(VALIDATION_SCHEMA as Joi.ObjectSchema);

    await fs.mkdir(DOCS_GENERATED_DIR, { recursive: true });
    await fs.writeFile(MODEL_FILE, JSON.stringify(model, null, 2), "utf8");

    console.log(
        `Generated config model with ${model.groups.length} groups (${model.all.length} keys) -> ${MODEL_FILE}`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

