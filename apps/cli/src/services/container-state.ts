import type { DoctorCheck } from "../types.js";

export interface ContainerState {
    name: string;
    state: string;
    status: string;
    /** Exit code of a stopped container, when the runtime reports one. */
    exitCode?: number;
}

/**
 * Parses `docker ps --format json` (one JSON object per line) and
 * `podman ps --format json` (a single JSON array). Field shapes differ
 * slightly: Podman reports Names as an array, Docker as a string, and only
 * Podman has an ExitCode field; Docker has the code in Status only.
 */
export function parseContainerStates(stdout: string): ContainerState[] {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return [];
    }

    const entries: unknown[] = trimmed.startsWith("[")
        ? asArray(JSON.parse(trimmed))
        : trimmed
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.startsWith("{"))
              .map((line) => JSON.parse(line));

    return entries.map((entry) => {
        const record = entry as Record<string, unknown>;
        const names = record.Names;
        const status = String(record.Status ?? "");
        const exitCode =
            typeof record.ExitCode === "number"
                ? record.ExitCode
                : /^Exited \((\d+)\)/.exec(status)?.[1];
        return {
            name: Array.isArray(names)
                ? String(names[0] ?? "")
                : String(names ?? record.Name ?? ""),
            state: String(record.State ?? ""),
            status,
            exitCode: exitCode === undefined ? undefined : Number(exitCode),
        };
    });
}

export function summarizeContainerStates(
    containers: ContainerState[],
    projectName: string,
): DoctorCheck {
    const name = "service containers";
    // A container that exited with code 0 has done its job, like the bucket
    // setup (rustfs-init) of the standard preset; it is not a stopped service.
    const services = containers.filter((container) => !hasCompleted(container));
    const completed = containers.length - services.length;
    if (services.length === 0) {
        return {
            name,
            status: "warn",
            message: `No containers found for project ${projectName}. Start it with eudiplo up.`,
        };
    }

    const unhealthy = services.filter((container) =>
        container.status.toLowerCase().includes("unhealthy"),
    );
    if (unhealthy.length > 0) {
        return {
            name,
            status: "fail",
            message: `Unhealthy: ${describe(unhealthy)}`,
        };
    }

    const notRunning = services.filter(
        (container) => container.state.toLowerCase() !== "running",
    );
    if (notRunning.length > 0) {
        return {
            name,
            status: "warn",
            message: `${services.length - notRunning.length}/${services.length} running. Not running: ${describe(notRunning)}`,
        };
    }

    const starting = services.filter((container) =>
        container.status.toLowerCase().includes("starting"),
    ).length;
    return {
        name,
        status: "pass",
        message: `${services.length} container(s) running${starting > 0 ? `, ${starting} still starting` : ""}${completed > 0 ? `, ${completed} completed` : ""}.`,
    };
}

function hasCompleted(container: ContainerState): boolean {
    return (
        container.state.toLowerCase() === "exited" && container.exitCode === 0
    );
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function describe(containers: ContainerState[]): string {
    return containers
        .map((container) => `${container.name} (${container.status})`)
        .join(", ");
}
