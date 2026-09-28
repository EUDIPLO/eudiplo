import { ConfigModule, ConfigModuleOptions } from "@nestjs/config";

/**
 * Keep E2E runs hermetic: never read a developer's apps/backend/.env.
 * Values such as PUBLIC_URL would otherwise override the defaults the suites
 * assert against. Tests configure the app through vitest.config.ts `env`,
 * `vi.stubEnv` or ConfigService instead.
 */
const forRoot = ConfigModule.forRoot.bind(ConfigModule);
ConfigModule.forRoot = (options?: ConfigModuleOptions) =>
    forRoot({ ...options, ignoreEnvFile: true });
