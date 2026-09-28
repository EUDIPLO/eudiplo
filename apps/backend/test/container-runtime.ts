import { describe, inject } from "vitest";

/**
 * `describe` for suites that start Testcontainers (Postgres, Vault, RustFS).
 * Skipped when test/global-setup.ts found no container runtime; in CI a
 * missing runtime fails the run instead.
 */
export const describeWithContainers = describe.runIf(
    inject("containerRuntimeAvailable"),
);
