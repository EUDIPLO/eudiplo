import { access, mkdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
    copyBundledDemoConfig,
    createComposeFile,
    createComposeEnv,
    createGlobalKmsConfig,
    createNoClientComposeOverride,
    configDirectoryName,
    demoComposeFileName,
    demoConfigDirectory,
    demoEnvFileName,
    defaultComposeFileName,
    defaultComposeOverrideFileName,
    defaultEnvFileName,
    hasFiles,
} from "./compose-project.js";
import {
    assertKnownService,
    assertServiceName,
    buildComposeBaseArgs,
    buildComposeListServicesArgs,
    buildComposeLogsArgs,
    buildComposePsArgs,
    buildComposePullArgs,
    buildComposeRestartArgs,
    parseServiceList,
} from "./compose-args.js";
import {
    parseContainerStates,
    summarizeContainerStates,
} from "./container-state.js";
import type { KubernetesScope } from "./kubectl.js";
import {
    buildCanIArgs,
    buildLogsArgs,
    buildRestartArgs,
    buildRolloutStatusArgs,
    resolveWorkload,
    buildGetEndpointSlicesArgs,
    buildGetPodsArgs,
    buildGetWorkloadArgs,
    resolveScope,
    resolveWorkloads,
} from "./kubectl.js";
import type {
    CommandContext,
    DeploymentDriver,
    DeploymentTarget,
    DoctorCheck,
    DriverCommandOptions,
    InstanceConfig,
} from "../types.js";

type ContainerRuntimeName = "docker" | "podman";

interface ComposeRuntime {
    command: string;
    name: ContainerRuntimeName;
}

export const drivers: Record<DeploymentTarget, DeploymentDriver> = {
    compose: {
        target: "compose",
        async diagnostics(instance, context) {
            const checks: DoctorCheck[] = [];
            const projectDirectory = instance.projectDirectory ?? context.cwd;
            const runtime = await resolveComposeRuntime(context.env);
            checks.push({
                name: "container runtime",
                status: runtime ? "pass" : "warn",
                message: runtime
                    ? `${runtime.name} found at ${runtime.command}`
                    : "Docker or Podman was not found in a supported install location.",
            });
            if (runtime) {
                checks.push(await composeProviderCheck(runtime, context));
                checks.push(
                    await composeServicesCheck(runtime, instance, context),
                );
            }
            for (const composeFile of getComposeFiles(instance)) {
                let found = true;
                try {
                    await access(resolve(projectDirectory, composeFile));
                } catch {
                    found = false;
                }
                checks.push({
                    name: "compose file",
                    status: found ? "pass" : "warn",
                    message: found
                        ? `${composeFile} is present`
                        : `Compose file not found: ${composeFile}`,
                });
            }
            return checks;
        },
        up(options) {
            return runCompose(["up", "-d", ...options.args], options);
        },
        down(options) {
            return runCompose(["down", ...options.args], options);
        },
        async logs(options) {
            const service = await resolveComposeService(options);
            const { follow, tail } = readLogOptions(options.flags);
            const since =
                typeof options.flags.since === "string"
                    ? options.flags.since
                    : undefined;
            return runCompose(
                [
                    ...buildComposeLogsArgs(service, { follow, tail, since }),
                    ...options.args,
                ],
                options,
            );
        },
        async ps(options) {
            return runCompose(
                [...buildComposePsArgs(), ...options.args],
                options,
            );
        },
        async pull(options) {
            const service = await resolveComposeService(options);
            return runCompose(
                [...buildComposePullArgs(service), ...options.args],
                options,
            );
        },
        async restart(options) {
            assertWritable(options);
            const service = await resolveComposeService(options);
            const restartArgs = buildComposeRestartArgs(service);
            const runtime = await resolveComposeRuntime(options.context.env);
            // Name the target before changing anything, as the Kubernetes
            // driver does, including which runtime will carry it out.
            options.context.stdout.write(
                `Restarting ${service ?? "all services"} of ${options.instanceName}${runtime ? ` with ${runtime.name} compose` : ""}\n`,
            );
            return runCompose([...restartArgs, ...options.args], options);
        },
    },
    external: {
        target: "external",
        async diagnostics() {
            return [];
        },
    },
    kubernetes: {
        target: "kubernetes",
        diagnostics: kubernetesDiagnostics,
        async logs(options) {
            const scope = resolveScope(options.instance, options.instanceName);
            const workload = resolveWorkload(
                options.instance,
                readServiceFlag(options.flags),
            );
            return runKubectl(
                [
                    ...buildLogsArgs(
                        scope,
                        workload,
                        readLogOptions(options.flags),
                    ),
                    ...options.args,
                ],
                options,
            );
        },
        async ps(options) {
            const scope = resolveScope(options.instance, options.instanceName);
            return runKubectl(
                [...buildGetPodsArgs(scope), ...options.args],
                options,
            );
        },
        async restart(options) {
            assertWritable(options);
            const scope = resolveScope(options.instance, options.instanceName);
            const workload = resolveWorkload(
                options.instance,
                readServiceFlag(options.flags),
            );

            // Name the target before changing anything: the whole risk of this
            // command is restarting the right workload in the wrong cluster.
            options.context.stdout.write(
                `Restarting ${workload} in namespace ${scope.namespace} on context ${scope.context}\n`,
            );

            const restarted = await runKubectl(
                [...buildRestartArgs(scope, workload), ...options.args],
                options,
            );
            if (restarted !== 0 || options.flags["no-wait"] === true) {
                return restarted;
            }
            return runKubectl(buildRolloutStatusArgs(scope, workload), options);
        },
    },
};

/**
 * A read-only instance is registered by someone who holds credentials for a
 * cluster they do not operate, so a mutation is refused outright rather than
 * attempted and left to fail on permissions.
 */
export function assertWritable({
    instance,
    instanceName,
}: DriverCommandOptions): void {
    if (instance.readOnly === true) {
        throw new Error(
            `Instance ${instanceName} is registered read-only. Re-register it without --read-only to allow changes.`,
        );
    }
}

function readServiceFlag(
    flags: Record<string, string | boolean>,
): string | undefined {
    const value = flags.service;
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readLogOptions(flags: Record<string, string | boolean>): {
    follow?: boolean;
    tail?: number;
} {
    const tail =
        typeof flags.tail === "string" ? Number(flags.tail) : undefined;
    if (tail !== undefined && !Number.isInteger(tail)) {
        throw new Error("--tail must be a whole number of lines.");
    }
    return { follow: flags.follow === true, tail };
}

async function runKubectl(
    args: string[],
    { context }: DriverCommandOptions,
): Promise<number> {
    const kubectl = await resolveKubectl(context.env);
    if (!kubectl) {
        throw new Error("kubectl was not found on PATH.");
    }
    return new Promise((resolveProcess, rejectProcess) => {
        const child = spawn(kubectl, args, {
            cwd: context.cwd,
            env: context.env,
            stdio: "inherit",
        });
        child.on("error", rejectProcess);
        child.on("close", (code) => resolveProcess(code ?? 1));
    });
}

async function kubernetesDiagnostics(
    instance: InstanceConfig,
    context: CommandContext,
): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];

    const kubectl = await resolveKubectl(context.env);
    checks.push({
        name: "kubectl",
        status: kubectl ? "pass" : "fail",
        message: kubectl
            ? `kubectl found at ${kubectl}`
            : "kubectl was not found on PATH.",
    });
    if (!kubectl) {
        return checks;
    }

    let scope: KubernetesScope;
    try {
        scope = resolveScope(instance, "this instance");
    } catch (error) {
        checks.push({
            name: "cluster scope",
            status: "fail",
            message: error instanceof Error ? error.message : String(error),
        });
        return checks;
    }

    checks.push({
        name: "cluster scope",
        status: "pass",
        message: `context ${scope.context}, namespace ${scope.namespace}`,
    });

    // A namespace read is the cheapest way to prove the context resolves, the
    // namespace exists and the credentials still work, all in one call.
    const namespaceRead = await captureKubectl(
        kubectl,
        ["get", "namespace", scope.namespace, "--context", scope.context],
        context,
    );
    checks.push({
        name: "namespace",
        status: namespaceRead.code === 0 ? "pass" : "fail",
        message:
            namespaceRead.code === 0
                ? `${scope.namespace} is reachable`
                : `${scope.namespace} could not be read: ${firstLine(namespaceRead.stderr)}`,
    });
    if (namespaceRead.code !== 0) {
        return checks;
    }

    // Ask the API server what this user may do rather than waiting for a
    // command to fail, so a missing role reads as a permission problem
    // instead of an unexplained error later on.
    for (const [verb, resource] of requiredPermissions(instance)) {
        const permission = await captureKubectl(
            kubectl,
            buildCanIArgs(scope, verb, resource),
            context,
        );
        const allowed = permission.stdout.trim() === "yes";
        checks.push({
            name: "permissions",
            status: allowed ? "pass" : "fail",
            message: allowed
                ? `may ${verb} ${resource}`
                : `may not ${verb} ${resource} in namespace ${scope.namespace}. Grant it with a Role binding covering ${verb} on ${resource}.`,
        });
    }

    for (const workload of resolveWorkloads(instance, undefined)) {
        const read = await captureKubectl(
            kubectl,
            buildGetWorkloadArgs(scope, workload),
            context,
        );
        checks.push(workloadCheck(workload, read));
    }

    const pods = await captureKubectl(
        kubectl,
        buildGetPodsArgs(scope),
        context,
    );
    checks.push({
        name: "pods",
        status: pods.code === 0 ? "pass" : "warn",
        message:
            pods.code === 0
                ? `${countPodLines(pods.stdout)} pod(s) in ${scope.namespace}`
                : `pods could not be listed: ${firstLine(pods.stderr)}`,
    });

    const endpoints = await captureKubectl(
        kubectl,
        buildGetEndpointSlicesArgs(scope),
        context,
    );
    checks.push(endpointCheck(endpoints));

    return checks;
}

/**
 * Kubernetes removes an unready pod from its Service endpoints, so a
 * deployment running below its desired replica count still serves traffic
 * through the remaining pods. That is a warning rather than a failure: only a
 * deployment with nothing ready is actually down.
 */
function workloadCheck(workload: string, read: CapturedCommand): DoctorCheck {
    if (read.code !== 0) {
        return {
            name: "workload",
            status: "fail",
            message: `${workload} could not be read: ${firstLine(read.stderr)}`,
        };
    }

    let replicas: { ready: number; desired: number };
    try {
        replicas = readReplicaCounts(read.stdout);
    } catch {
        return {
            name: "workload",
            status: "warn",
            message: `${workload} exists, but its replica counts could not be read.`,
        };
    }

    const counts = `${replicas.ready}/${replicas.desired} replicas ready`;
    if (replicas.desired === 0) {
        return {
            name: "workload",
            status: "warn",
            message: `${workload} is scaled to zero.`,
        };
    }
    if (replicas.ready === 0) {
        return {
            name: "workload",
            status: "fail",
            message: `${workload} has no ready replicas (${counts}).`,
        };
    }
    return {
        name: "workload",
        status: replicas.ready < replicas.desired ? "warn" : "pass",
        message: `${workload}: ${counts}`,
    };
}

export function readReplicaCounts(stdout: string): {
    ready: number;
    desired: number;
} {
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed) || !isRecord(parsed.status)) {
        throw new Error("Unexpected workload payload.");
    }

    // `readyReplicas` is omitted entirely rather than set to zero when no pod
    // is ready, and `spec.replicas` defaults to 1 when unset.
    const ready = numberOr(parsed.status.readyReplicas, 0);
    const desired = isRecord(parsed.spec)
        ? numberOr(parsed.spec.replicas, 1)
        : numberOr(parsed.status.replicas, 1);
    return { ready, desired };
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : fallback;
}

/**
 * A Service with no ready addresses is the usual shape of "the API answers on
 * localhost but not through the ingress", so it is worth calling out
 * separately from pod status.
 */
function endpointCheck(endpoints: CapturedCommand): DoctorCheck {
    if (endpoints.code !== 0) {
        return {
            name: "service endpoints",
            status: "warn",
            message: `endpoints could not be listed: ${firstLine(endpoints.stderr)}`,
        };
    }

    let unready: string[];
    try {
        unready = unreadyEndpoints(endpoints.stdout);
    } catch {
        return {
            name: "service endpoints",
            status: "warn",
            message: "endpoints could not be parsed.",
        };
    }

    return {
        name: "service endpoints",
        status: unready.length === 0 ? "pass" : "fail",
        message:
            unready.length === 0
                ? "all services have ready addresses"
                : `no ready addresses for: ${unready.join(", ")}`,
    };
}

/**
 * A Service may own several EndpointSlices (one per address family, and more
 * once it grows), so readiness is grouped by service name: a Service is ready
 * when any of its slices carries a ready endpoint.
 */
export function unreadyEndpoints(stdout: string): string[] {
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
        throw new Error("Unexpected endpointslice payload.");
    }

    const readyByService = new Map<string, boolean>();
    for (const item of parsed.items) {
        if (!isRecord(item) || !isRecord(item.metadata)) {
            continue;
        }
        const labels = isRecord(item.metadata.labels)
            ? item.metadata.labels
            : {};
        const service = String(
            labels["kubernetes.io/service-name"] ??
                item.metadata.name ??
                "unknown",
        );
        const endpoints = Array.isArray(item.endpoints) ? item.endpoints : [];
        const ready = endpoints.some(
            (endpoint) =>
                isRecord(endpoint) &&
                // An omitted ready condition means ready, per the API contract.
                (!isRecord(endpoint.conditions) ||
                    endpoint.conditions.ready !== false),
        );
        readyByService.set(
            service,
            (readyByService.get(service) ?? false) || ready,
        );
    }

    return [...readyByService.entries()]
        .filter(([, ready]) => !ready)
        .map(([service]) => service)
        .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredPermissions(
    instance: InstanceConfig,
): Array<[verb: string, resource: string]> {
    const permissions: Array<[string, string]> = [
        ["get", "pods"],
        ["get", "deployments"],
        ["get", "pods/log"],
    ];
    if (instance.readOnly !== true) {
        permissions.push(["patch", "deployments"]);
    }
    return permissions;
}

function countPodLines(stdout: string): number {
    const lines = stdout.trim().split("\n").filter(Boolean);
    return Math.max(lines.length - 1, 0);
}

function firstLine(value: string): string {
    return value.trim().split("\n")[0] ?? "no output";
}

async function resolveKubectl(
    env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
    const configured = env.EUDIPLO_KUBECTL;
    if (configured) {
        return (await exists(configured)) ? configured : undefined;
    }
    for (const candidate of executableCandidates("kubectl", env)) {
        if (await exists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

interface CapturedCommand {
    code: number;
    stdout: string;
    stderr: string;
}

async function captureKubectl(
    kubectl: string,
    args: string[],
    context: CommandContext,
): Promise<CapturedCommand> {
    return new Promise((resolveProcess) => {
        const child = spawn(kubectl, args, {
            env: context.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (error) => {
            resolveProcess({ code: 1, stdout, stderr: error.message });
        });
        child.on("close", (code) =>
            resolveProcess({ code: code ?? 1, stdout, stderr }),
        );
    });
}

export async function ensureComposeProject(
    cwd: string,
    options: {
        mode?: "standard" | "demo";
        database?: "sqlite" | "postgres";
        storage?: "local" | "s3";
        kms?: "db" | "vault";
        publicUrl?: string;
        authClientId?: string;
        authClientSecret?: string;
        demoTenant?: boolean;
        noClient?: boolean;
        force?: boolean;
        reset?: boolean;
        imageTagOverride?: string;
    },
): Promise<InstanceConfig> {
    await ensureProjectDirectory(cwd);
    const mode = options.mode ?? "standard";
    const composeFileName =
        mode === "demo" ? demoComposeFileName : defaultComposeFileName;
    const envFileName = mode === "demo" ? demoEnvFileName : defaultEnvFileName;

    const composePath = join(cwd, composeFileName);
    const overridePath = join(cwd, defaultComposeOverrideFileName);
    const envPath = join(cwd, envFileName);
    const configPath = join(cwd, configDirectoryName);
    const globalKmsPath = join(configPath, "kms.json");

    await mkdir(configPath, { recursive: true, mode: 0o700 });

    if (mode === "demo" && options.reset === true) {
        await removeDemoProjectAssets(cwd);
    }

    if (!(await exists(composePath)) || options.force === true) {
        await writeFile(composePath, await createComposeFile(), "utf8");
    }
    if (!(await exists(envPath)) || options.force === true) {
        await writeFile(
            envPath,
            createComposeEnv({
                mode,
                imageTagOverride: options.imageTagOverride,
                database: options.database,
                storage: options.storage,
                kms: options.kms,
                publicUrl: options.publicUrl,
                authClientId: options.authClientId,
                authClientSecret: options.authClientSecret,
            }),
            {
                encoding: "utf8",
                mode: 0o600,
            },
        );
    }

    if (!(await exists(globalKmsPath)) || options.force === true) {
        await writeFile(
            globalKmsPath,
            createGlobalKmsConfig(options.kms ?? "db"),
            { encoding: "utf8", mode: 0o600 },
        );
    }

    if (mode === "demo" || options.demoTenant === true) {
        const demoConfigPath = join(cwd, demoConfigDirectory);
        const hasExistingConfig = await hasFiles(demoConfigPath);
        if (
            !hasExistingConfig ||
            options.force === true ||
            options.reset === true
        ) {
            await copyBundledDemoConfig(demoConfigPath, true);
        }
    }

    if (options.noClient === true) {
        await writeFile(overridePath, createNoClientComposeOverride(), "utf8");
    } else {
        await removeIfExists(overridePath);
    }

    const composeFiles = [composeFileName];
    if (options.noClient === true) {
        composeFiles.push(defaultComposeOverrideFileName);
    }

    return {
        target: "compose",
        url: "http://localhost:3000",
        clientUrl:
            options.noClient === true ? undefined : "http://localhost:4200",
        composeFile: defaultComposeFileName,
        composeFiles,
        composeProfiles: composeProfiles(options),
        envFile: envFileName,
        projectName: mode === "demo" ? "eudiplo-demo" : "eudiplo",
        projectDirectory: resolve(cwd),
    };
}

async function ensureProjectDirectory(directory: string): Promise<void> {
    try {
        const entry = await stat(directory);
        if (!entry.isDirectory()) {
            throw new Error(`Project directory points to a file: ${directory}`);
        }
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            return;
        }
        throw error;
    }
}

function composeProfiles(options: {
    mode?: "standard" | "demo";
    database?: "sqlite" | "postgres";
    storage?: "local" | "s3";
    kms?: "db" | "vault";
}): string[] | undefined {
    if (options.mode === "demo") {
        return undefined;
    }

    const profiles: string[] = [];
    if (options.database === "postgres") {
        profiles.push("postgres");
    }
    if (options.storage === "s3") {
        profiles.push("s3");
    }
    if (options.kms === "vault") {
        profiles.push("vault");
    }
    return profiles.length > 0 ? profiles : undefined;
}

export async function demoProjectExists(cwd: string): Promise<boolean> {
    return (
        (await exists(join(cwd, demoComposeFileName))) ||
        (await exists(join(cwd, demoEnvFileName))) ||
        (await exists(join(cwd, demoConfigDirectory))) ||
        (await exists(join(cwd, ".eudiplo/demo-config")))
    );
}

async function removeDemoProjectAssets(cwd: string): Promise<void> {
    await rm(join(cwd, demoComposeFileName), { force: true });
    await rm(join(cwd, demoEnvFileName), { force: true });
    await rm(join(cwd, defaultComposeOverrideFileName), { force: true });
    await rm(join(cwd, demoConfigDirectory), { recursive: true, force: true });
    await rm(join(cwd, ".eudiplo/demo-config"), {
        recursive: true,
        force: true,
    });
}

export function unsupportedCommand(
    command: string,
    target: DeploymentTarget,
): string {
    if (target === "external") {
        return `${command} is not available for externally managed deployments`;
    }
    return `${command} is not available for ${target} deployments`;
}

export async function runCompose(
    args: string[],
    { instance, context }: DriverCommandOptions,
): Promise<number> {
    const projectDirectory = instance.projectDirectory ?? context.cwd;
    const composeArgs = [
        ...buildComposeBaseArgs(
            instance,
            projectDirectory,
            getComposeFiles(instance),
        ),
        ...args,
    ];

    const composeRuntime = await resolveComposeRuntime(context.env);
    if (!composeRuntime) {
        context.stderr.write(
            "Docker or Podman was not found in a supported install location.\n",
        );
        return 1;
    }

    return new Promise((resolveProcess) => {
        const child = spawn(composeRuntime.command, composeArgs, {
            cwd: projectDirectory,
            env: context.env,
            stdio: "inherit",
        });

        child.on("error", (error) => {
            context.stderr.write(`${error.message}\n`);
            resolveProcess(1);
        });
        child.on("close", (code) => resolveProcess(code ?? 1));
    });
}

/**
 * Runs Compose with captured output. Used for read-only queries whose
 * result the CLI needs, such as the service list.
 */
async function captureCompose(
    args: string[],
    { instance, context }: DriverCommandOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
    const projectDirectory = instance.projectDirectory ?? context.cwd;
    const composeRuntime = await resolveComposeRuntime(context.env);
    if (!composeRuntime) {
        throw new Error(
            "Docker or Podman was not found in a supported install location.",
        );
    }
    const composeArgs = [
        ...buildComposeBaseArgs(
            instance,
            projectDirectory,
            getComposeFiles(instance),
        ),
        ...args,
    ];
    return new Promise((resolveProcess) => {
        const child = spawn(composeRuntime.command, composeArgs, {
            cwd: projectDirectory,
            env: context.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (error) =>
            resolveProcess({ code: 1, stdout, stderr: error.message }),
        );
        child.on("close", (code) =>
            resolveProcess({ code: code ?? 1, stdout, stderr }),
        );
    });
}

/**
 * Validates `--service` against the services Compose actually defines for
 * this instance, so a typo fails with the list of real names instead of a
 * runtime error.
 */
async function resolveComposeService(
    options: DriverCommandOptions,
): Promise<string | undefined> {
    const service = readServiceFlag(options.flags);
    if (service === undefined) {
        return undefined;
    }
    assertServiceName(service);
    const listed = await captureCompose(
        buildComposeListServicesArgs(),
        options,
    );
    if (listed.code !== 0) {
        throw new Error(
            `Could not list Compose services: ${listed.stderr.trim() || `exit code ${listed.code}`}`,
        );
    }
    assertKnownService(service, parseServiceList(listed.stdout));
    return service;
}

/**
 * `podman compose` delegates to an external provider, and a broken or
 * missing provider only shows up when a command is run. Asking the runtime
 * for its compose version surfaces that here instead.
 */
async function composeProviderCheck(
    runtime: ComposeRuntime,
    context: CommandContext,
): Promise<DoctorCheck> {
    const version = await captureRuntime(
        runtime.command,
        ["compose", "version"],
        context,
    );
    if (version.code !== 0) {
        return {
            name: "compose provider",
            status: "fail",
            message: `${runtime.name} compose is not usable: ${firstLine(version.stderr) || `exit code ${version.code}`}`,
        };
    }
    return {
        name: "compose provider",
        status: "pass",
        message: firstLine(version.stdout) || `${runtime.name} compose works`,
    };
}

async function composeServicesCheck(
    runtime: ComposeRuntime,
    instance: InstanceConfig,
    context: CommandContext,
): Promise<DoctorCheck> {
    if (!instance.projectName) {
        return {
            name: "service containers",
            status: "skip",
            message:
                "This instance has no Compose project name, so its containers cannot be identified.",
        };
    }
    const listed = await captureRuntime(
        runtime.command,
        [
            "ps",
            "--all",
            "--filter",
            `label=com.docker.compose.project=${instance.projectName}`,
            "--format",
            "json",
        ],
        context,
    );
    if (listed.code !== 0) {
        return {
            name: "service containers",
            status: "warn",
            message: `Containers could not be listed: ${firstLine(listed.stderr) || `exit code ${listed.code}`}`,
        };
    }
    try {
        return summarizeContainerStates(
            parseContainerStates(listed.stdout),
            instance.projectName,
        );
    } catch {
        return {
            name: "service containers",
            status: "warn",
            message: `The container list returned by ${runtime.name} could not be read.`,
        };
    }
}

function captureRuntime(
    command: string,
    args: string[],
    context: CommandContext,
): Promise<CapturedCommand> {
    return new Promise((resolveProcess) => {
        const child = spawn(command, args, {
            env: context.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (error) =>
            resolveProcess({ code: 1, stdout, stderr: error.message }),
        );
        child.on("close", (code) =>
            resolveProcess({ code: code ?? 1, stdout, stderr }),
        );
    });
}

export async function resolveComposeRuntime(
    env: NodeJS.ProcessEnv,
): Promise<ComposeRuntime | undefined> {
    const preferredRuntime = parsePreferredRuntime(
        env.EUDIPLO_CONTAINER_RUNTIME,
    );
    const candidates = preferredRuntime
        ? [preferredRuntime]
        : (["docker", "podman"] as const);

    for (const runtime of candidates) {
        const command = await resolveRuntimeExecutable(runtime, env);
        if (command) {
            return { command, name: runtime };
        }
    }

    return undefined;
}

function parsePreferredRuntime(
    value: string | undefined,
): ContainerRuntimeName | undefined {
    if (!value) {
        return undefined;
    }
    if (value === "docker" || value === "podman") {
        return value;
    }
    throw new Error("EUDIPLO_CONTAINER_RUNTIME must be docker or podman.");
}

async function resolveRuntimeExecutable(
    runtime: ContainerRuntimeName,
    env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
    for (const executablePath of runtimeExecutablePaths(runtime, env)) {
        if (await exists(executablePath)) {
            return executablePath;
        }
    }

    return undefined;
}

function runtimeExecutablePaths(
    runtime: ContainerRuntimeName,
    env: NodeJS.ProcessEnv,
): string[] {
    const pathCandidates = (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((pathEntry) => runtimePathCandidates(pathEntry, runtime, env));

    if (process.platform === "win32") {
        if (runtime === "docker") {
            return [
                String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe`,
                ...pathCandidates,
            ];
        }
        return [
            String.raw`C:\Program Files\RedHat\Podman\podman.exe`,
            ...pathCandidates,
        ];
    }

    return [
        `/usr/local/bin/${runtime}`,
        `/opt/homebrew/bin/${runtime}`,
        `/usr/bin/${runtime}`,
        ...pathCandidates,
    ];
}

function runtimePathCandidates(
    pathEntry: string,
    runtime: ContainerRuntimeName,
    env: NodeJS.ProcessEnv,
): string[] {
    if (process.platform !== "win32") {
        return [join(pathEntry, runtime)];
    }

    const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean);
    return [
        join(pathEntry, runtime),
        ...extensions.map((ext) => join(pathEntry, `${runtime}${ext}`)),
    ];
}

/**
 * Generic PATH lookup, including the Windows PATHEXT extensions, for
 * executables that have no well-known install location.
 */
function executableCandidates(name: string, env: NodeJS.ProcessEnv): string[] {
    const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
    if (process.platform !== "win32") {
        return pathEntries.map((entry) => join(entry, name));
    }
    const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean);
    return pathEntries.flatMap((entry) => [
        join(entry, name),
        ...extensions.map((ext) => join(entry, `${name}${ext}`)),
    ]);
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

function getComposeFiles(instance: InstanceConfig): string[] {
    return (
        instance.composeFiles ??
        (instance.composeFile ? [instance.composeFile] : [])
    );
}

async function removeIfExists(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (error) {
        if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
        ) {
            throw error;
        }
    }
}
