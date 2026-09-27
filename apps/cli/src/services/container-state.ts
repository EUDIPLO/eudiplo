import type { DoctorCheck } from "../types.js";

export interface ContainerState {
    name: string;
    state: string;
    status: string;
}

/**
 * Parses `docker ps --format json` (one JSON object per line) and
 * `podman ps --format json` (a single JSON array). Field shapes differ
 * slightly: Podman reports Names as an array, Docker as a string.
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
        return {
            name: Array.isArray(names)
                ? String(names[0] ?? "")
                : String(names ?? record.Name ?? ""),
            state: String(record.State ?? ""),
            status: String(record.Status ?? ""),
        };
    });
}

export function summarizeContainerStates(
    containers: ContainerState[],
    projectName: string,
): DoctorCheck {
    const name = "service containers";
    if (containers.length === 0) {
        return {
            name,
            status: "warn",
            message: `No containers found for project ${projectName}. Start it with eudiplo up.`,
        };
    }

    const unhealthy = containers.filter((container) =>
        container.status.toLowerCase().includes("unhealthy"),
    );
    if (unhealthy.length > 0) {
        return {
            name,
            status: "fail",
            message: `Unhealthy: ${describe(unhealthy)}`,
        };
    }

    const notRunning = containers.filter(
        (container) => container.state.toLowerCase() !== "running",
    );
    if (notRunning.length > 0) {
        return {
            name,
            status: "warn",
            message: `${containers.length - notRunning.length}/${containers.length} running. Not running: ${describe(notRunning)}`,
        };
    }

    const starting = containers.filter((container) =>
        container.status.toLowerCase().includes("starting"),
    ).length;
    return {
        name,
        status: "pass",
        message: `${containers.length} container(s) running${starting > 0 ? `, ${starting} still starting` : ""}.`,
    };
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function describe(containers: ContainerState[]): string {
    return containers
        .map((container) => `${container.name} (${container.status})`)
        .join(", ");
}
