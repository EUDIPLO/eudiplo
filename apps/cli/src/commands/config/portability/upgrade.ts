import { createHash } from "node:crypto";
import {
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rename,
    rm,
} from "node:fs/promises";
import {
    basename,
    dirname,
    extname,
    join,
    relative,
    resolve,
    sep,
} from "node:path";
import {
    assertConfigBundle,
    type ConfigBundle,
    ConfigBundleCodec,
} from "@eudiplo/config-format/config-bundle.js";
import {
    bareFileVersion,
    CONFIG_FORMATS,
    CONFIG_RESOURCE_KINDS,
    CONFIG_SINGLETON_IDS,
    type ConfigResourceKind,
    isConfigDocument,
    normalizeDocument,
    resourceId,
    schemaUrl,
} from "@eudiplo/config-format/config-format.js";
import { atomicWriteFile } from "@eudiplo/config-format/config-io.js";
import {
    configChanges,
    stableConfigJson,
} from "@eudiplo/config-format/config-values.js";
import { readStringFlag } from "../../../options.js";
import type { CommandContext, ParsedArgs } from "../../../types.js";
import { TENANT_RESOURCE_REGISTRY } from "../validate/registry.js";
import { upgradeDocument } from "./migrations.js";

const codec = new ConfigBundleCodec();
function parse(text: string, path: string): any {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Invalid JSON in ${path}`);
    }
}
function upgradeJson(input: any, file: string, context: CommandContext): any {
    const bundle = Array.isArray(input?.documents);
    if (bundle) assertConfigBundle(input);
    const results = (bundle ? input.documents : [input]).map(
        (document: unknown) => upgradeDocument(document),
    );
    let blocked = false;
    for (const result of results) {
        for (const issue of result.issues) {
            context.stderr.write(
                `${file}${issue.path}: ${issue.severity} ${issue.code}: ${issue.message}\n`,
            );
            if (issue.severity !== "warning") blocked = true;
        }
        for (const migration of result.migrations)
            context.stdout.write(`${file}: migration ${migration}\n`);
    }
    if (blocked) throw new Error(`${file}: upgrade blocked; no output written`);
    if (!bundle) return results[0].document;
    const documents = results.map(
        (result: ReturnType<typeof upgradeDocument>) => result.document,
    );
    const resources = input.manifest.resources.map(
        (resource: ConfigBundle["manifest"]["resources"][number]) => {
            const index = input.documents.findIndex(
                (candidate: any) =>
                    normalizeDocument(candidate).kind === resource.kind &&
                    resourceId(candidate) === resource.id,
            )!;
            const document = documents[index];
            return {
                ...resource,
                id: resourceId(document),
                $schema: document.$schema,
                sha256: createHash("sha256")
                    .update(JSON.stringify(document))
                    .digest("hex"),
            };
        },
    );
    const output = {
        ...input,
        manifest: { ...input.manifest, formatVersion: 2, resources },
        documents,
    };
    assertConfigBundle(output);
    return output;
}
function report(
    input: unknown,
    output: unknown,
    file: string,
    parsed: ParsedArgs,
    context: CommandContext,
): boolean {
    const changed = stableConfigJson(input) !== stableConfigJson(output);
    context.stdout.write(
        `${file}: ${changed ? "upgrade required" : "current"}\n`,
    );
    if (parsed.flags.diff === true)
        for (const change of configChanges(input, output)) {
            context.stdout.write(
                `  ${change.path}: ${JSON.stringify(change.before) ?? "(absent)"} -> ${JSON.stringify(change.after) ?? "(absent)"}\n`,
            );
        }
    return changed;
}
function inferredKind(path: string): ConfigResourceKind | undefined {
    const normalized = path.split(sep).join("/");
    const match = TENANT_RESOURCE_REGISTRY.find((entry) =>
        entry.kind === "file"
            ? normalized === entry.file || normalized.endsWith(`/${entry.file}`)
            : normalized.endsWith(`/${entry.subfolder}/${basename(path)}`) ||
              normalized === `${entry.subfolder}/${basename(path)}`,
    );
    return CONFIG_RESOURCE_KINDS.find(
        (kind) =>
            `${CONFIG_FORMATS[kind].file}.schema.json` === match?.schemaFile,
    );
}
function wrapBare(kind: ConfigResourceKind, input: any, path: string): unknown {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error(`${path}: configuration must be an object`);
    const singleton = CONFIG_SINGLETON_IDS;
    const spec = structuredClone(input);
    if (kind === "KeyChain" && spec.key && !spec.keySource) {
        spec.keySource = { type: "private-jwk", jwk: spec.key };
        delete spec.key;
    }
    const id = String(
        singleton[kind] ?? spec.id ?? spec.clientId ?? basename(path, ".json"),
    );
    if (!singleton[kind]) spec[kind === "Client" ? "clientId" : "id"] = id;
    return {
        $schema: schemaUrl(kind, bareFileVersion(kind, input)),
        metadata: { generation: 1 },
        spec,
    };
}
async function folderFiles(path: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const file = join(path, entry.name);
        if (entry.isSymbolicLink())
            throw new Error(`Config folder contains a symbolic link: ${file}`);
        if (entry.isDirectory()) files.push(...(await folderFiles(file)));
        else if (entry.isFile()) files.push(file);
    }
    return files.sort();
}
async function upgradeFolder(
    source: string,
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const outputs = new Map<string, string>();
    let changed = 0;
    for (const file of await folderFiles(source)) {
        if (
            extname(file) !== ".json" ||
            relative(source, file).split(sep).includes("images")
        )
            continue;
        const input = parse(await readFile(file, "utf8"), file);
        const kind = inferredKind(relative(source, file));
        if (!kind && !isConfigDocument(input)) continue;
        const candidate = isConfigDocument(input)
            ? input
            : wrapBare(kind!, input, file);
        const output = upgradeJson(candidate, file, context);
        if (kind && normalizeDocument(output).kind !== kind)
            throw new Error(`${file}: expected ${kind} configuration`);
        if (report(input, output, relative(source, file), parsed, context))
            changed++;
        outputs.set(
            relative(source, file),
            `${JSON.stringify(output, null, 2)}\n`,
        );
    }
    if (!outputs.size)
        throw new Error(`No configuration documents found in ${source}`);
    context.stdout.write(
        `${outputs.size - changed} current, ${changed} require upgrading\n`,
    );
    if (parsed.flags.check === true) return changed ? 1 : 0;
    if (parsed.flags["dry-run"] === true) return 0;
    const destination = resolve(
        context.cwd,
        readStringFlag(parsed.flags, "output") ?? `${source}.upgraded`,
    );
    const overlap = (parent: string, child: string) => {
        const path = relative(parent, child);
        return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
    };
    if (overlap(source, destination) || overlap(destination, source))
        throw new Error(
            "Folder output must be separate from the source directory",
        );
    await lstat(destination).then(
        () => {
            throw new Error(`Output already exists: ${destination}`);
        },
        (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
        },
    );
    await mkdir(dirname(destination), { recursive: true });
    const staging = await mkdtemp(
        join(dirname(destination), ".eudiplo-upgrade-"),
    );
    try {
        await cp(source, staging, {
            recursive: true,
            filter: (path) =>
                path === source ||
                !relative(source, path)
                    .split(sep)
                    .some((part) => part.startsWith(".")),
        });
        for (const [path, contents] of outputs)
            await atomicWriteFile(join(staging, path), contents);
        await rename(staging, destination);
        context.stdout.write(
            `Wrote upgraded configuration folder to ${destination}\n`,
        );
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
    return 0;
}
export async function upgradeFile(
    parsed: ParsedArgs,
    context: CommandContext,
): Promise<number> {
    const name = parsed.positionals[0];
    if (!name)
        throw new Error("Usage: eudiplo config upgrade <file-or-folder>");
    const source = resolve(context.cwd, name);
    const info = await lstat(source);
    if (info.isSymbolicLink())
        throw new Error(
            "Select a config file or directory directly, not a symbolic link",
        );
    if (info.isDirectory()) return upgradeFolder(source, parsed, context);
    const zipped = extname(source).toLowerCase() === ".zip";
    const input = zipped
        ? codec.decode(await readFile(source))
        : parse(await readFile(source, "utf8"), source);
    const output = upgradeJson(input, source, context);
    const changed = report(input, output, name, parsed, context);
    if (parsed.flags.check === true) return changed ? 1 : 0;
    if (parsed.flags["dry-run"] === true) return 0;
    const destination = resolve(
        context.cwd,
        readStringFlag(parsed.flags, "output") ??
            `${name}.upgraded.${zipped ? "zip" : "json"}`,
    );
    await atomicWriteFile(
        destination,
        zipped ? codec.encode(output) : `${JSON.stringify(output, null, 2)}\n`,
    );
    context.stdout.write(`Wrote upgraded configuration to ${destination}\n`);
    return 0;
}
