import { resolve } from "node:path";
import type { InstanceConfig } from "../types.js";

/**
 * Argument construction for `docker compose` and `podman compose`.
 *
 * Both runtimes accept the same subcommands and flags used here, so the
 * builders are runtime-agnostic: the runtime only decides which executable
 * receives the argv. Every value that comes from the user is validated before
 * it is placed in the argv, so it can never be read as an extra option.
 */

// Compose service names: must start with a letter or digit, then letters,
// digits, dots, underscores or dashes. Rejecting a leading "-" is what keeps
// a service name from being parsed as a flag.
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

// Go-style durations as accepted by `compose logs --since`, e.g. 10m, 1h30m.
const DURATION = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;

// RFC 3339 / ISO 8601 timestamps, e.g. 2026-09-01 or 2026-09-01T12:00:00Z.
const TIMESTAMP =
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export interface ComposeLogOptions {
    follow?: boolean;
    tail?: number;
    since?: string;
}

export function assertServiceName(service: string): void {
    if (!SERVICE_NAME.test(service)) {
        throw new Error(
            `Invalid service name ${JSON.stringify(service)}. Service names start with a letter or digit and contain only letters, digits, ".", "_" and "-".`,
        );
    }
}

export function assertSince(since: string): void {
    const isDuration = DURATION.test(since);
    const isTimestamp =
        TIMESTAMP.test(since) && !Number.isNaN(Date.parse(since));
    if (!isDuration && !isTimestamp) {
        throw new Error(
            `Invalid --since value ${JSON.stringify(since)}. Use a duration such as 10m or 2h30m, or a timestamp such as 2026-09-01T12:00:00Z.`,
        );
    }
}

function assertTail(tail: number): void {
    if (!Number.isInteger(tail) || tail < 0) {
        throw new Error("--tail must be a whole number of lines, 0 or more.");
    }
}

/**
 * Options shared by every Compose invocation for an instance: env file,
 * compose files, profiles and project name, all resolved against the
 * project directory.
 */
export function buildComposeBaseArgs(
    instance: InstanceConfig,
    projectDirectory: string,
    composeFiles: string[],
): string[] {
    const args = ["compose"];
    if (instance.envFile) {
        args.push("--env-file", resolve(projectDirectory, instance.envFile));
    }
    for (const composeFile of composeFiles) {
        args.push("-f", resolve(projectDirectory, composeFile));
    }
    for (const profile of instance.composeProfiles ?? []) {
        args.push("--profile", profile);
    }
    if (instance.projectName) {
        args.push("--project-name", instance.projectName);
    }
    return args;
}

export function buildComposePsArgs(): string[] {
    return ["ps"];
}

export function buildComposeListServicesArgs(): string[] {
    return ["config", "--services"];
}

export function buildComposeLogsArgs(
    service: string | undefined,
    options: ComposeLogOptions = {},
): string[] {
    const args = ["logs"];
    if (options.follow === true) {
        args.push("--follow");
    }
    if (options.tail !== undefined) {
        assertTail(options.tail);
        args.push("--tail", String(options.tail));
    }
    if (options.since !== undefined) {
        assertSince(options.since);
        args.push("--since", options.since);
    }
    if (service !== undefined) {
        assertServiceName(service);
        args.push(service);
    }
    return args;
}

export function buildComposePullArgs(
    services: string | readonly string[] | undefined,
): string[] {
    const args = ["pull"];
    for (const service of typeof services === "string"
        ? [services]
        : (services ?? [])) {
        assertServiceName(service);
        args.push(service);
    }
    return args;
}

export function buildComposeUpArgs(): string[] {
    return ["up", "-d"];
}

export function buildComposeRestartArgs(service: string | undefined): string[] {
    const args = ["restart"];
    if (service !== undefined) {
        assertServiceName(service);
        args.push(service);
    }
    return args;
}

/**
 * Parses `compose config --services` output. `podman compose` can print a
 * provider notice before delegating, so anything that is not a valid service
 * name is dropped rather than trusted.
 */
export function parseServiceList(stdout: string): string[] {
    return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => SERVICE_NAME.test(line))
        .sort();
}

export function assertKnownService(service: string, known: string[]): void {
    if (!known.includes(service)) {
        throw new Error(
            `Unknown service ${service}. Services in this project: ${known.join(", ") || "none"}.`,
        );
    }
}
