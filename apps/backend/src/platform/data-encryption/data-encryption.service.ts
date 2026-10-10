import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
    ENCRYPTION_KEY_PROVIDER,
    EncryptionKeyProvider,
} from "./providers/encryption-key-provider.interface.js";

/**
 * Service for encrypting and decrypting sensitive data at rest.
 * Uses AES-256-GCM for authenticated encryption.
 *
 * The encryption key is fetched at runtime from the configured provider:
 * - env (default): Derived from MASTER_SECRET
 * - vault: Fetched from HashiCorp Vault (optional)
 * - aws: Fetched from AWS Secrets Manager (optional)
 * - azure: Fetched from Azure Key Vault (optional)
 *
 * With vault/aws/azure the key is only in RAM, not in environment variables.
 */
@Injectable()
export class DataEncryptionService {
    private encryptionKey: Buffer | null = null;
    private initialized = false;
    private readonly algorithm = "aes-256-gcm" as const;
    private readonly ivLength = 12; // 96 bits for GCM
    private readonly authTagLength = 16; // 128 bits
    private readonly logger = new Logger(DataEncryptionService.name);

    constructor(
        @Inject(ENCRYPTION_KEY_PROVIDER)
        private readonly keyProvider: EncryptionKeyProvider,
    ) {}

    /**
     * Initialize the encryption service by fetching the key from the provider.
     * Must be called during module initialization before any encrypt/decrypt operations.
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.logger.log(
            `Initializing encryption with key provider: ${this.keyProvider.name}`,
        );
        this.encryptionKey = await this.keyProvider.getKey();
        this.initialized = true;
        this.logger.log("Encryption service initialized successfully");
    }

    /**
     * Ensure the service is initialized before operations.
     */
    private ensureInitialized(): Buffer {
        if (!this.initialized || !this.encryptionKey) {
            throw new Error(
                "Encryption service not initialized. Call initialize() first.",
            );
        }
        return this.encryptionKey;
    }

    /**
     * Encrypt a string value using AES-256-GCM.
     * Returns format: base64(iv):base64(authTag):base64(ciphertext)
     */
    encrypt(plaintext: string): string {
        const key = this.ensureInitialized();

        const iv = randomBytes(this.ivLength);
        const cipher = createCipheriv(this.algorithm, key, iv, {
            authTagLength: this.authTagLength,
        });

        const encrypted = Buffer.concat([
            cipher.update(plaintext, "utf8"),
            cipher.final(),
        ]);

        const authTag = cipher.getAuthTag();

        // Format: iv:authTag:ciphertext (all base64)
        return [
            iv.toString("base64"),
            authTag.toString("base64"),
            encrypted.toString("base64"),
        ].join(":");
    }

    /**
     * Decrypt a value that was encrypted with encrypt().
     * Expects format: base64(iv):base64(authTag):base64(ciphertext)
     */
    decrypt(encryptedValue: string): string {
        const key = this.ensureInitialized();

        const parts = encryptedValue.split(":");
        if (parts.length !== 3) {
            throw new Error("Invalid encrypted value format");
        }

        const [ivBase64, authTagBase64, ciphertextBase64] = parts;
        const iv = Buffer.from(ivBase64, "base64");
        const authTag = Buffer.from(authTagBase64, "base64");
        const ciphertext = Buffer.from(ciphertextBase64, "base64");

        const decipher = createDecipheriv(this.algorithm, key, iv, {
            authTagLength: this.authTagLength,
        });

        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]);

        return decrypted.toString("utf8");
    }

    /**
     * Encrypt a JSON-serializable value.
     */
    encryptJson<T>(value: T): string {
        return this.encrypt(JSON.stringify(value));
    }

    /**
     * Decrypt a JSON value.
     */
    decryptJson<T>(encryptedValue: string): T {
        return JSON.parse(this.decrypt(encryptedValue));
    }

    /**
     * Check if a value appears to be encrypted (has the expected format).
     */
    isEncrypted(value: string): boolean {
        if (typeof value !== "string") return false;
        const parts = value.split(":");
        if (parts.length !== 3) return false;

        // Check if all parts look like base64
        const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
        return parts.every((part) => base64Regex.test(part));
    }
}
