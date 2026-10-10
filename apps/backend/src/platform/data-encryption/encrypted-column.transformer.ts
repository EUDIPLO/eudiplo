import { ValueTransformer } from "typeorm";
import { DataEncryptionService } from "./data-encryption.service.js";

/**
 * Singleton holder for the encryption service instance.
 * This is necessary because TypeORM transformers don't support dependency injection.
 */
let encryptionServiceInstance: DataEncryptionService | null = null;

/**
 * Initialize the encryption transformer with a DataEncryptionService instance.
 * Must be called during application bootstrap before any database operations.
 */
export function initializeEncryptionTransformer(
    service: DataEncryptionService,
): void {
    encryptionServiceInstance = service;
}

/**
 * Get the encryption service instance.
 * Throws if not initialized.
 */
export function getEncryptionService(): DataEncryptionService {
    if (!encryptionServiceInstance) {
        throw new Error(
            "DataEncryptionService not initialized. Call initializeEncryptionTransformer() during bootstrap.",
        );
    }
    return encryptionServiceInstance;
}

/**
 * TypeORM column transformer for encrypting JSON data at rest.
 * Encrypts on write (to database) and decrypts on read (from database).
 *
 * Usage:
 * @Column("text", { transformer: EncryptedJsonTransformer })
 * sensitiveData: SomeType;
 */
export const EncryptedJsonTransformer: ValueTransformer = {
    /**
     * Transform value when writing to database.
     * Encrypts the JSON value.
     */
    to(value: unknown): string | null {
        if (value === null || value === undefined) {
            return null;
        }
        return getEncryptionService().encryptJson(value);
    },

    /**
     * Transform value when reading from database.
     * Decrypts the encrypted value back to JSON.
     */
    from(value: string | null): unknown {
        if (value === null || value === undefined) {
            return null;
        }

        const service = getEncryptionService();

        // Handle migration: if value is not encrypted, return as-is (parsed JSON)
        // This allows existing unencrypted data to be read during migration
        if (!service.isEncrypted(value)) {
            // Try to parse as JSON (for existing unencrypted data)
            try {
                return typeof value === "string" ? JSON.parse(value) : value;
            } catch {
                return value;
            }
        }

        return service.decryptJson(value);
    },
};

/**
 * TypeORM column transformer for encrypting string data at rest.
 * Use for non-JSON string values.
 *
 * Usage:
 * @Column("text", { transformer: EncryptedStringTransformer })
 * sensitiveString: string;
 */
export const EncryptedStringTransformer: ValueTransformer = {
    /**
     * Transform value when writing to database.
     */
    to(value: string | null): string | null {
        if (value === null || value === undefined) {
            return null;
        }
        return getEncryptionService().encrypt(value);
    },

    /**
     * Transform value when reading from database.
     */
    from(value: string | null): string | null {
        if (value === null || value === undefined) {
            return null;
        }

        const service = getEncryptionService();

        // Handle migration: if value is not encrypted, return as-is
        if (!service.isEncrypted(value)) {
            return value;
        }

        return service.decrypt(value);
    },
};

/**
 * Apply `fn` to the string values at `path` in a JSON value and return a copy;
 * the input is left unchanged. Path segments are object keys or array
 * indexes, and `*` matches every key or index.
 *
 * Example: `mapJsonPath(servers, "*.upstream.clientSecret", fn)`
 */
export function mapJsonPath(
    value: unknown,
    path: string,
    fn: (leaf: string) => string,
): unknown {
    return mapSegments(value, path.split("."), fn);
}

function mapSegments(
    value: unknown,
    [segment, ...rest]: string[],
    fn: (leaf: string) => string,
): unknown {
    if (segment === undefined) {
        return typeof value === "string" ? fn(value) : value;
    }
    if (Array.isArray(value)) {
        return value.map((item, index) =>
            segment === "*" || segment === String(index)
                ? mapSegments(item, rest, fn)
                : item,
        );
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                segment === "*" || segment === key
                    ? mapSegments(item, rest, fn)
                    : item,
            ]),
        );
    }
    return value;
}

/**
 * TypeORM column transformer for JSON columns that hold a secret next to
 * plain configuration. Only the string values at `paths` are encrypted; the
 * rest of the document stays readable in the database.
 *
 * Usage:
 * @Column("json", { transformer: encryptedJsonPaths("config.value") })
 * auth: WebhookAuth;
 */
export function encryptedJsonPaths(...paths: string[]): ValueTransformer {
    const apply = (value: unknown, fn: (leaf: string) => string) =>
        paths.reduce((current, path) => mapJsonPath(current, path, fn), value);

    return {
        to(value: unknown): unknown {
            if (value === null || value === undefined) {
                return value;
            }
            const service = getEncryptionService();
            return apply(value, (leaf) => service.encrypt(leaf));
        },

        from(value: unknown): unknown {
            if (value === null || value === undefined) {
                return value;
            }
            const service = getEncryptionService();
            // Values written before EncryptStoredSecrets1784500000000 ran are
            // still plaintext.
            return apply(value, (leaf) =>
                service.isEncrypted(leaf) ? service.decrypt(leaf) : leaf,
            );
        },
    };
}
