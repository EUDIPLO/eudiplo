import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PresentationRequestSchema } from "../../backend/src/verifier/oid4vp/dto/presentation-request.schema.js";
import { buildRequestBodyModel } from "./request-docs/model.js";

const output = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/generated/presentation-request.json");

async function main() {
    const model = buildRequestBodyModel(PresentationRequestSchema);
    await fs.mkdir(dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(model, null, 2)}\n`, "utf8");
    console.log(`Generated request body model -> ${output}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
