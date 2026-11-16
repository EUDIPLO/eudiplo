import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { ConfigBundleCodec } from "@eudiplo/config-format/config-bundle.js";
import { atomicWriteFile } from "@eudiplo/config-format/config-io.js";
import { readStringFlag } from "../../../options.js";
import { resolveInstance } from "../../../services/instance-selection.js";
import type { CliConfig, CommandContext, ParsedArgs } from "../../../types.js";
import { buildJsonReport, formatTextReport } from "../validate/report.js";
import { loadTenantConfigSchemas } from "../validate/schemas.js";
import { validateTenantDirectory } from "../validate/validator.js";
import {
    allowedFolderEnv,
    assertFolderContained,
    packTenantFolder,
} from "./folder-bundle.js";
import { upgradeFile } from "./upgrade.js";

const codec = new ConfigBundleCodec();

type Action =
    | "export"
    | "plan"
    | "import"
    | "upgrade"
    | "operations"
    | "recover";

export async function runPortabilityCommand(
    action: Action,
    config: CliConfig,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    if (action === "upgrade") return upgradeFile(parsed, context);
    const [, instance] = resolveInstance(config, parsed);
    const token =
        readStringFlag(parsed.flags, "token") ?? context.env.EUDIPLO_TOKEN;
    if (!token) {
        throw new Error(
            "An access token is required via --token or EUDIPLO_TOKEN.",
        );
    }
    const authHeaders = {
        authorization: `Bearer ${token}`,
    };
    const baseUrl = instance.url.replace(/\/$/, "");

    if (action === "operations" || action === "recover") {
        const id = parsed.positionals[0];
        if (
            action === "recover" &&
            (!id || parsed.flags["confirm-worker-stopped"] !== true)
        )
            throw new Error(
                "Recovery requires an operation ID and --confirm-worker-stopped after stopping the original worker",
            );
        const path = id ? `/${encodeURIComponent(id)}` : "";
        const response = await context.fetch(
            `${baseUrl}/api/config-bundles/operations${path}${action === "recover" ? "/acknowledge-interruption?confirmWorkerStopped=true" : ""}`,
            {
                method: action === "recover" ? "POST" : "GET",
                headers: authHeaders,
            },
        );
        await assertOk(response);
        context.stdout.write(
            `${JSON.stringify(await response.json(), null, 2)}\n`,
        );
        return 0;
    }
    if (action === "export") {
        const output = resolvePath(
            readStringFlag(parsed.flags, "output") ??
                "eudiplo-config-bundle.zip",
            context,
        );
        const format =
            extname(output).toLowerCase() === ".json" ? "json" : "zip";
        const response = await context.fetch(
            `${baseUrl}/api/config-bundles/export?format=${format}`,
            { headers: authHeaders },
        );
        await assertOk(response);
        const data =
            format === "zip"
                ? Buffer.from(await response.arrayBuffer())
                : `${JSON.stringify(await response.json(), null, 2)}\n`;
        await atomicWriteFile(output, data);
        context.stdout.write(`Exported configuration bundle to ${output}\n`);
        return 0;
    }

    const file = parsed.positionals[0];
    if (!file)
        throw new Error(`Usage: eudiplo config ${action} <bundle-or-folder>`);
    const format = planFormat(action, parsed);
    const bundlePath = resolvePath(file, context);
    const folder = await isDirectory(bundlePath);
    const allowEnv = readStringFlag(parsed.flags, "allow-env");
    if (allowEnv !== undefined && !folder)
        throw new Error(
            "--allow-env applies to a tenant folder only; a bundle's placeholders are resolved by the server.",
        );
    const folderEnv = allowedFolderEnv(allowEnv, context.env);
    if (folder) {
        await assertFolderContained(bundlePath);
        // Offline first: a folder that does not validate never reaches the API.
        const validation = await validateTenantDirectory(
            bundlePath,
            basename(bundlePath),
            await loadTenantConfigSchemas(),
            folderEnv,
        );
        if (!validation.valid) {
            if (
                validation.errors.some((issue) =>
                    issue.message.startsWith("Unresolved placeholder"),
                )
            )
                context.stderr.write(
                    "Placeholders resolve only from the variables named in --allow-env.\n",
                );
            if (format === "json")
                context.stdout.write(
                    `${JSON.stringify(buildJsonReport([validation]), null, 2)}\n`,
                );
            else
                context.stderr.write(
                    formatTextReport("tenant", bundlePath, [validation]),
                );
            context.stderr.write(
                `Not sent to ${baseUrl}: fix the configuration folder first.\n`,
            );
            return 1;
        }
    }
    const archive = folder || extname(bundlePath).toLowerCase() === ".zip";
    const mode = readStringFlag(parsed.flags, "mode") ?? "upsert";
    const query = new URLSearchParams({ mode });
    if (action === "import") {
        const planFile = readStringFlag(parsed.flags, "plan");
        const fingerprint = planFile
            ? JSON.parse(await readFile(resolvePath(planFile, context), "utf8"))
                  .planFingerprint
            : readStringFlag(parsed.flags, "plan-fingerprint");
        if (
            typeof fingerprint !== "string" ||
            !/^[a-f0-9]{64}$/.test(fingerprint)
        )
            throw new Error(
                "Import requires --plan <saved-plan.json> or --plan-fingerprint from a reviewed plan",
            );
        query.set("planFingerprint", fingerprint);
    }
    if (parsed.flags["confirm-replace"] === true) {
        query.set("confirmReplace", "true");
    }
    let body: BodyInit;
    let headers: Record<string, string> = authHeaders;
    let endpoint: string = action;
    if (archive) {
        const form = new FormData();
        // A folder goes as a ZIP: the archive endpoints accept up to 50 MiB,
        // the JSON body 10 MB, and assets are base64 in JSON.
        const zip = folder
            ? codec.encode(await packTenantFolder(bundlePath, folderEnv))
            : await readFile(bundlePath);
        form.set(
            "bundle",
            new Blob([new Uint8Array(zip)], { type: "application/zip" }),
            folder ? `${basename(bundlePath)}.zip` : basename(bundlePath),
        );
        body = form;
        endpoint = `${action}/archive`;
    } else {
        const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
        body = JSON.stringify(bundle);
        headers = { ...headers, "content-type": "application/json" };
    }
    const response = await context.fetch(
        `${baseUrl}/api/config-bundles/${endpoint}?${query}`,
        { method: "POST", headers, body },
    );
    await assertOk(response);
    const result = await response.json();
    if (action === "plan") {
        const output = readStringFlag(parsed.flags, "output");
        if (output)
            await atomicWriteFile(
                resolvePath(output, context),
                `${JSON.stringify(result, null, 2)}\n`,
            );
    }
    if (action === "plan" && format === "text") {
        for (const item of (result as any).items ?? []) {
            context.stdout.write(
                `${item.kind}/${item.id}: ${item.action}${item.action === "unchanged" && item.metadataChanged ? " (ownership update)" : ""}\n`,
            );
            for (const change of item.changes ?? [])
                context.stdout.write(
                    `  ${change.path}: ${JSON.stringify(change.before) ?? "(absent)"} -> ${JSON.stringify(change.after) ?? "(absent)"}\n`,
                );
            for (const issue of item.issues ?? [])
                context.stderr.write(
                    `${item.kind}/${item.id}${issue.path}: ${issue.message}\n`,
                );
        }
        for (const issue of (result as any).issues ?? []) {
            context.stderr.write(
                `${issue.code ?? "CONFIG_ISSUE"}${issue.path ?? ""}: ${issue.message}\n`,
            );
        }
        for (const asset of (result as any).assets ?? [])
            context.stdout.write(`${asset.path}: ${asset.action}\n`);
        context.stdout.write(
            `Plan fingerprint: ${(result as any).planFingerprint}\n`,
        );
        context.stdout.write(
            `Applicable: ${(result as any).applicable ? "yes" : "no"}\n`,
        );
    } else context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return (result as any).applicable === false ? 1 : 0;
}

/**
 * Output format of `config plan`. JSON stays the default so scripts that parse
 * today's output keep working; `--diff` is an alias for `--format text`.
 */
function planFormat(action: Action, parsed: ParsedArgs): "text" | "json" {
    const format = readStringFlag(parsed.flags, "format");
    const diff = parsed.flags.diff === true;
    if (action !== "plan") return "text";
    if (format !== undefined && format !== "text" && format !== "json")
        throw new Error("Unsupported --format value. Use text or json.");
    if (diff && format === "json")
        throw new Error(
            "--diff is the text format; use either --diff or --format json, not both.",
        );
    return diff ? "text" : (format ?? "json");
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            throw new Error(`Bundle or folder not found: ${path}`);
        throw error;
    }
}

function resolvePath(value: string, context: CommandContext): string {
    return isAbsolute(value) ? value : join(context.cwd, value);
}

async function assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    const body = await response.text();
    throw new Error(`EUDIPLO API returned ${response.status}: ${body}`);
}
