import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Public and internal URLs must be known before the Nest application is
 * compiled: typed capability settings (e.g. OID4VCI/OID4VP URLs) read them once
 * at module initialization, so overriding them via ConfigService.set() later
 * has no effect.
 */
const PUBLIC_DOMAIN =
    process.env.VITE_DOMAIN ?? "host.testcontainers.internal:3000";

export default defineConfig({
    test: {
        include: ["**/oidf/*.e2e-spec.ts"],
        globals: true,
        root: "./",
        fileParallelism: false,
        env: {
            MASTER_SECRET: "e2e-test-master-secret-do-not-use-in-production",
            AUTH_CLIENT_ID: "e2e-test-client",
            AUTH_CLIENT_SECRET: "e2e-test-secret",
            ENCRYPTION_KEY:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            DB_SYNCHRONIZE: "true",
            DB_MIGRATIONS_RUN: "false",
            PUBLIC_URL: `https://${PUBLIC_DOMAIN}`,
            INTERNAL_URL: "https://localhost:3000",
            // The conformance suite and the backend run on the local network.
            OUTBOUND_URL_ALLOW_HTTP: "true",
            OUTBOUND_URL_ALLOW_PRIVATE_NETWORK: "true",
        },
    },
    plugins: [swc.vite()],
});
