import { AUDIT_LOG_VALIDATION_SCHEMA } from "../../audit-log/audit-log-validation.schema.js";
import { AUTH_VALIDATION_SCHEMA } from "../../auth/auth-validation.schema.js";
import { CRYPTO_VALIDATION_SCHEMA } from "../../crypto/key/crypto-implementation/crypto-validation.schema.js";
import { DB_VALIDATION_SCHEMA } from "../../database/database-validation.schema.js";
import { ISSUER_VALIDATION_SCHEMA } from "../../issuer/issuer-validation.schema.js";
import { STATUS_LIST_VALIDATION_SCHEMA } from "../../issuer/status-list/status-list-validation.schema.js";
import { SESSION_VALIDATION_SCHEMA } from "../../session/session-validation.schema.js";
import { STORAGE_VALIDATION_SCHEMA } from "../../storage/storage-validation.schema.js";
import { VERIFIER_VALIDATION_SCHEMA } from "../../verifier/verifier-validation.schema.js";
import { WEBHOOK_VALIDATION_SCHEMA } from "../../webhook/webhook-validation.schema.js";
import { ENCRYPTION_VALIDATION_SCHEMA } from "../data-encryption/encryption-validation.schema.js";
import { LOG_VALIDATION_SCHEMA } from "../observability/log-validation.schema.js";
import { CONFIG_VALIDATION_SCHEMA } from "./config-validation.schema.js";
import { SKIP_VALIDATION_SCHEMA } from "./skip-validation.schema.js";
import { TLS_VALIDATION_SCHEMA } from "./tls-validation.schema.js";
import { BASE_VALIDATION_SCHEMA } from "./validation.schema.js";

/**
 * Combined validation schema for the application configuration
 */
export const VALIDATION_SCHEMA = BASE_VALIDATION_SCHEMA.concat(
    AUTH_VALIDATION_SCHEMA,
)
    .concat(DB_VALIDATION_SCHEMA)
    .concat(CONFIG_VALIDATION_SCHEMA)
    .concat(LOG_VALIDATION_SCHEMA)
    .concat(CRYPTO_VALIDATION_SCHEMA)
    .concat(ISSUER_VALIDATION_SCHEMA)
    .concat(SESSION_VALIDATION_SCHEMA)
    .concat(STORAGE_VALIDATION_SCHEMA)
    .concat(STATUS_LIST_VALIDATION_SCHEMA)
    .concat(AUDIT_LOG_VALIDATION_SCHEMA)
    .concat(ENCRYPTION_VALIDATION_SCHEMA)
    .concat(VERIFIER_VALIDATION_SCHEMA)
    .concat(WEBHOOK_VALIDATION_SCHEMA)
    .concat(TLS_VALIDATION_SCHEMA)
    .concat(SKIP_VALIDATION_SCHEMA);
