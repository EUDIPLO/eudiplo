import { fileURLToPath } from "node:url";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        name: "backend-e2e",
        include: ["**/*.e2e-spec.ts"],
        exclude: ["**/oidf/**"],
        globals: true,
        root: fileURLToPath(new URL("..", import.meta.url)),
        fileParallelism: false,
        // The first verifier offer / signed metadata request of a suite can
        // take several seconds; the 5s default makes local runs flaky.
        testTimeout: 15_000,
        // Fails fast when port 3000 is taken and detects Docker for the
        // Testcontainers suites.
        globalSetup: ["./test/global-setup.ts"],
        // Ignores apps/backend/.env so developer settings do not leak in.
        setupFiles: ["./test/setup-e2e.ts"],
        coverage: {
            provider: "v8",
            reportsDirectory: "./coverage/e2e",
            reporter: ["text", "lcov", "cobertura"],
            cleanOnRerun: false,
        },
        reporters: ["default", "junit"],
        outputFile: {
            junit: "../test-report.junit.xml",
        },
        env: {
            // Required environment variables for E2E tests
            MASTER_SECRET:
                process.env.MASTER_SECRET ??
                "e2e-test-master-secret-do-not-use-in-production",
            AUTH_CLIENT_ID: process.env.AUTH_CLIENT_ID ?? "e2e-test-client",
            AUTH_CLIENT_SECRET:
                process.env.AUTH_CLIENT_SECRET ?? "e2e-test-secret",
            ENCRYPTION_KEY:
                process.env.ENCRYPTION_KEY ??
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            // Use synchronize for tests (fresh DB each run), skip migrations
            DB_SYNCHRONIZE: "true",
            DB_MIGRATIONS_RUN: "false",
        },
    },
    plugins: [swc.vite()],
});
