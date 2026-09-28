import { connect } from "node:net";
import type { TestProject } from "vitest/node";

declare module "vitest" {
    export interface ProvidedContext {
        /** True when a Docker-compatible runtime is reachable for Testcontainers. */
        containerRuntimeAvailable: boolean;
    }
}

/** Port the E2E suites bind the backend to (PUBLIC_URL is http://localhost:3000). */
const E2E_PORT = 3000;

/**
 * Resolves true when something already accepts connections on host:port.
 * supertest sends requests to 127.0.0.1:<port>, so another process holding the
 * port (dev server, docker compose) would silently answer the tests' requests.
 */
function isPortInUse(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host, port });
        socket.setTimeout(1000);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
        });
        socket.once("error", () => resolve(false));
    });
}

async function detectContainerRuntime(): Promise<boolean> {
    try {
        const { getContainerRuntimeClient } = await import("testcontainers");
        await getContainerRuntimeClient();
        return true;
    } catch {
        return false;
    }
}

export default async function setup(project: TestProject) {
    for (const host of ["127.0.0.1", "::1"]) {
        if (await isPortInUse(host, E2E_PORT)) {
            throw new Error(
                `Port ${E2E_PORT} is already in use on ${host}. The E2E suites start the backend on this port; ` +
                    "stop the other process first (for example a running `pnpm dev:backend` or `docker compose up`).",
            );
        }
    }

    if (process.env.E2E_SKIP_CONTAINERS === "true") {
        console.warn(
            "\n[e2e] E2E_SKIP_CONTAINERS=true: skipping the Postgres, Vault and S3 (RustFS) suites.\n",
        );
        project.provide("containerRuntimeAvailable", false);
        return;
    }

    const available = await detectContainerRuntime();
    if (!available) {
        if (process.env.CI) {
            throw new Error(
                "No container runtime found, but CI is set. The Postgres, Vault and S3 suites must run in CI.",
            );
        }
        console.warn(
            "\n[e2e] No container runtime (Docker) found: skipping the Postgres, Vault and S3 (RustFS) suites. " +
                "Start Docker to run them.\n",
        );
    }
    project.provide("containerRuntimeAvailable", available);
}
