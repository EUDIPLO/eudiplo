import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCommandReference } from "../../cli/src/commands/commands/render.js";
import { createProgram } from "../../cli/src/runtime.js";
import type { CommandContext } from "../../cli/src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, "../docs/_generated/cli-reference.md");

/**
 * The rendered reference starts with its own title and a "generated" note. The
 * docs page (reference/cli.md) embeds it below its own title and intro, so both
 * are dropped and the command sections become sections of that page.
 */
function withoutTitle(markdown: string): string {
    return markdown.replace(/^# .*\n+(Generated from[^\n]*\n+)?/, "");
}

async function main(): Promise<void> {
    const context = documentationContext();
    const program = createProgram(context, () => undefined);
    const markdown = withoutTitle(renderCommandReference(program, "markdown"));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, markdown, "utf8");
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
