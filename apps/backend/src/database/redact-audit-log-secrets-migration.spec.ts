import { DataSource } from "typeorm";
import {
    redactAuditLogSecretsContract,
    redactAuditLogSecretsEntities,
} from "../../test/persistence/redact-audit-log-secrets.contract.js";

redactAuditLogSecretsContract(() =>
    new DataSource({
        type: "better-sqlite3",
        database: ":memory:",
        entities: redactAuditLogSecretsEntities,
        synchronize: true,
    }).initialize(),
);
