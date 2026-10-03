import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCommandReference } from "../../cli/src/commands/commands/render.js";
import { createProgram } from "../../cli/src/runtime.js";
import type { CommandContext } from "../../cli/src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, "../docs/_generated/cli-reference.md");

const GENERATED_WARNING = [
    "> **Auto-generated.** Do not edit manually.",
    "> Run `pnpm --filter @eudiplo/docs run prebuild` (apps/docs/scripts/generate-cli-reference.ts).",
    "",
].join("\n");

async function main(): Promise<void> {
    const context = documentationContext();
    const program = createProgram(context, () => undefined);
    const markdown = renderCommandReference(program, "markdown");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${GENERATED_WARNING}\n${markdown}`, "utf8");
    console.log(`Generated ${outputPath}`);
}

function documentationContext(): CommandContext {
    return {
        cwd: process.cwd(),
        env: {},
        interactive: false,
        stdout: { write: () => true },
        stderr: { write: () => true },
        fetch,
    };
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
