import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { DataSource, DataSourceOptions } from "typeorm";
import * as migrations from "./migrations/index.js";
import { buildPostgresSslOptions } from "./postgres-ssl-options.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

// Load environment variables
config({ path: join(currentDir, "..", "..", ".env") });
config({ path: join(currentDir, "..", "..", "..", "..", ".env") });

const dbType = process.env.DB_TYPE as "sqlite" | "postgres" | undefined;

const commonOptions: Partial<DataSourceOptions> = {
    synchronize: false,
    logging: process.env.DB_LOGGING === "true",
    // The same migration list as the backend (database.module.ts). A file glob
    // would also load index.ts and report every migration twice.
    migrations: Object.values(migrations),
    migrationsTableName: "typeorm_migrations",
};

let dataSourceOptions: DataSourceOptions;

if (dbType === "postgres") {
    dataSourceOptions = {
        type: "postgres",
        host: process.env.DB_HOST || "localhost",
        port: Number.parseInt(process.env.DB_PORT || "5432", 10),
        username: process.env.DB_USERNAME || "postgres",
        password: process.env.DB_PASSWORD || "postgres",
        database: process.env.DB_DATABASE || "eudiplo",
        ssl: buildPostgresSslOptions((key: string) => process.env[key]),
        ...commonOptions,
    } as DataSourceOptions;
} else {
    // Same default as the backend (FOLDER in platform/config/validation.schema.ts),
    // so the CLI works on the database the dev backend uses.
    const folder = process.env.FOLDER || "../../tmp";
    dataSourceOptions = {
        // The driver the backend uses (database.module.ts).
        type: "better-sqlite3",
        database: join(folder, "service.db"),
        ...commonOptions,
    } as DataSourceOptions;
}

export const AppDataSource = new DataSource(dataSourceOptions);
