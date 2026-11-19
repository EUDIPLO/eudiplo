import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { ConfigBundleCodec } from "@eudiplo/config-format/config-bundle.js";
import { atomicWriteFile } from "@eudiplo/config-format/config-io.js";
import { readStringFlag } from "../../../options.js";
import { resolveInstance } from "../../../services/instance-selection.js";
import type { CliConfig, CommandContext, ParsedArgs } from "../../../types.js";
import { buildJsonReport, formatTextReport } from "../validate/report.js";
import { loadTenantConfigSchemas } from "../validate/schemas.js";
import { validateTenantDirectory } from "../validate/validator.js";
import {
    assertFolderContained,
    folderEnvironment,
    maskFilledText,
    maskFilledValues,
    packTenantFolder,
} from "./folder-bundle.js";
import { writeTenantFolder } from "./folder-export.js";
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
        const requested =
            readStringFlag(parsed.flags, "output") ??
            "eudiplo-config-bundle.zip";
        const output = resolvePath(requested, context);
        if (await isFolderOutput(requested, output))
            // resolve() drops the trailing slash.
            return exportFolder(baseUrl, authHeaders, resolve(output), context);
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
        if (!extname(output))
            context.stderr.write(
                `Note: wrote a ZIP bundle. To write a tenant folder instead, end --output with a slash: ${requested.replace(/[\\/]+$/, "")}/\n`,
            );
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
    const folderEnv = folderEnvironment(allowEnv, context.env);
    if (folder) {
        await assertFolderContained(bundlePath);
        // Offline first: a folder that does not validate never reaches the API.
        const validation = await validateTenantDirectory(
            bundlePath,
            basename(bundlePath),
            await loadTenantConfigSchemas(),
            folderEnv.env,
            { allowUnresolvedPlaceholders: true },
        );
        // An exported folder keeps its `${…}` placeholders. The server plans
        // them as SECRET_REQUIRED, which blocks the import of that resource.
        for (const issue of validation.unresolved ?? []) {
            const reason = issue.variable && folderEnv.withheld(issue.variable);
            context.stderr.write(
                `${issue.file} ${issue.path}: ${issue.message}${reason ? ` (${reason})` : ""}; the plan blocks this resource with SECRET_REQUIRED\n`,
            );
        }
        for (const warning of validation.warnings) {
            context.stderr.write(`${warning.file}: ${warning.message}\n`);
        }
        if (!validation.valid) {
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
            ? codec.encode(await packTenantFolder(bundlePath, folderEnv.env))
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
    if (action === "import" && !response.ok) {
        const failure = await applyFailure(response);
        if (failure)
            return reportApplyFailure(
                maskFilledValues(failure, folderEnv.filled),
                context,
            );
    }
    await assertOk(response, folderEnv.filled);
    // The plan shows field values, and a placeholder can sit in any field.
    const result = maskFilledValues(await response.json(), folderEnv.filled);
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
 * `config export --output <dir>/`: fetch the bundle as a ZIP (the codec checks
 * paths, checksums and size limits) and write it as a tenant folder.
 */
async function exportFolder(
    baseUrl: string,
    headers: Record<string, string>,
    output: string,
    context: CommandContext,
): Promise<number> {
    const response = await context.fetch(
        `${baseUrl}/api/config-bundles/export?format=zip`,
        { headers },
    );
    await assertOk(response);
    const bundle = codec.decode(Buffer.from(await response.arrayBuffer()));
    const { files, assets } = await writeTenantFolder(bundle, output);
    context.stdout.write(
        `Exported tenant ${bundle.manifest.tenant} to ${output}: ${files.size} files, ${assets} images\n`,
    );
    if (basename(output) !== bundle.manifest.tenant)
        context.stderr.write(
            `Note: the folder is not named after the tenant (${bundle.manifest.tenant}). The startup import and replace mode use the folder name, so rename it before using it as a tenant folder.\n`,
        );
    for (const warning of bundle.manifest.warnings)
        context.stderr.write(`warning ${warning.code}: ${warning.message}\n`);
    const requirements = bundle.manifest.requirements;
    if (requirements.length) {
        context.stdout.write(
            `${requirements.length} value(s) to supply before this folder can be imported:\n`,
        );
        for (const requirement of requirements) {
            const file =
                files.get(
                    `${requirement.resource.kind}/${requirement.resource.id}`,
                ) ?? `${requirement.resource.kind}/${requirement.resource.id}`;
            const value = requirement.placeholder
                ? `\${${requirement.placeholder}}`
                : "private key";
            context.stdout.write(
                `  ${file} ${requirement.path}: ${value} (${requirement.code})\n`,
            );
        }
    }
    return 0;
}

/**
 * Output format of `config plan`. JSON stays the default so scripts that parse
 * today's output keep working; `--diff` is an alias for `--format text`.
 */
function planFormat(action: Action, parsed: ParsedArgs): "text" | "json" {
    // Commander restricts --format to text or json.
    const format = readStringFlag(parsed.flags, "format") as
        | "text"
        | "json"
        | undefined;
    const diff = parsed.flags.diff === true;
    if (action !== "plan") return "text";
    if (diff && format === "json")
        throw new Error(
            "--diff is the text format; use either --diff or --format json, not both.",
        );
    return diff ? "text" : (format ?? "json");
}

/**
 * `config export` writes a tenant folder when `--output` ends with a slash or
 * names an existing directory; any other path is a bundle file, a ZIP unless
 * it ends with `.json`.
 */
async function isFolderOutput(
    requested: string,
    output: string,
): Promise<boolean> {
    if (/[\\/]$/.test(requested)) return true;
    try {
        return (await stat(output)).isDirectory();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
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

interface ApplyOperation {
    stage: string;
    kind?: string;
    id?: string;
    path?: string;
    status: "pending" | "running" | "completed" | "failed";
}

interface ApplyFailure {
    code: "CONFIG_APPLY_FAILED";
    operationId: string;
    message?: string;
    failedOperation?: { stage: string; kind?: string; id?: string };
    operations: ApplyOperation[];
    generatedSecrets?: unknown[];
}

/**
 * The body of an import that stopped part-way (CONFIG_APPLY_FAILED), or
 * undefined for any other error. Reads a clone, so assertOk can still report
 * the original response.
 */
async function applyFailure(
    response: Response,
): Promise<ApplyFailure | undefined> {
    try {
        const body = await response.clone().json();
        if (
            body?.code === "CONFIG_APPLY_FAILED" &&
            typeof body.operationId === "string" &&
            Array.isArray(body.operations)
        )
            return body;
    } catch {
        // Not JSON: fall through to the generic error.
    }
    return undefined;
}

/**
 * An import is not one transaction: steps before the failed one stay applied.
 * Shows one line per resource with its state, and keeps the server's report
 * as JSON on stdout, where generated client secrets are shown once.
 */
function reportApplyFailure(
    failure: ApplyFailure,
    context: CommandContext,
): number {
    const resources = new Map<
        string,
        { label: string; statuses: ApplyOperation["status"][] }
    >();
    for (const operation of failure.operations) {
        const deleting = operation.stage.startsWith("delete");
        const name =
            operation.path ?? `${operation.kind ?? "?"}/${operation.id ?? "?"}`;
        const key = `${deleting ? "delete" : "apply"} ${name}`;
        const entry = resources.get(key) ?? {
            label: deleting ? `${name} (delete)` : name,
            statuses: [],
        };
        entry.statuses.push(operation.status);
        resources.set(key, entry);
    }
    const counts = { completed: 0, failed: 0, pending: 0 };
    const lines = [...resources.values()].map(({ label, statuses }) => {
        const state = resourceState(statuses);
        counts[state]++;
        return `  ${state.padEnd(9)} ${label}`;
    });
    const failed = failure.failedOperation;
    const at = failed
        ? ` at ${failed.stage} ${failed.kind ?? ""}${failed.id ? `/${failed.id}` : ""}`
        : "";
    context.stderr.write(
        `Import stopped${at}: ${counts.completed} completed, ${counts.failed} failed, ${counts.pending} not started.\n`,
    );
    context.stderr.write(`${lines.join("\n")}\n`);
    context.stderr.write(
        "Completed resources stay applied; the failed one may have partial effects.\n",
    );
    if (failure.generatedSecrets?.length)
        context.stderr.write(
            `${failure.generatedSecrets.length} client secret(s) were generated before the failure and are shown only once: see generatedSecrets in the output.\n`,
        );
    context.stderr.write(
        `Inspect the report with: eudiplo config operations ${failure.operationId}\nThen run plan again before retrying.\n`,
    );
    context.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    return 1;
}

/** A resource with any failed step failed; one with every step done completed. */
function resourceState(
    statuses: ApplyOperation["status"][],
): "completed" | "failed" | "pending" {
    if (statuses.some((status) => status === "failed" || status === "running"))
        return "failed";
    return statuses.every((status) => status === "completed")
        ? "completed"
        : "pending";
}

async function assertOk(
    response: Response,
    filled: Map<string, string> = new Map(),
): Promise<void> {
    if (response.ok) return;
    // An error message can quote a value the CLI filled into the folder.
    const body = maskFilledText(await response.text(), filled);
    throw new Error(`EUDIPLO API returned ${response.status}: ${body}`);
}
