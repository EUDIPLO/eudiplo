import { createHash } from "node:crypto";
import {
    GetSecretValueCommand,
    SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EncryptionKeyProvider } from "./encryption-key-provider.interface.js";

/**
 * AWS Secrets Manager encryption key provider.
 * Fetches the encryption key from AWS Secrets Manager at startup.
 *
 * Security benefits:
 * - Key is fetched at runtime, only exists in RAM
 * - Not exposed via environment variables
 * - AWS provides IAM-based access control, audit logging via CloudTrail
 * - Automatic key rotation support via AWS Secrets Manager rotation
 * - Works seamlessly with IAM roles for EKS/ECS (no credentials in env vars)
 *
 * Required environment variables:
 * - AWS_REGION: AWS region (e.g., us-east-1)
 * - AWS_ENCRYPTION_SECRET_NAME: Secret name in Secrets Manager
 *
 * Optional (if not using IAM roles):
 * - AWS_ACCESS_KEY_ID: AWS access key
 * - AWS_SECRET_ACCESS_KEY: AWS secret key
 *
 * Secret format in AWS Secrets Manager:
 * - Plain text: 32-byte key encoded as base64 or hex
 * - JSON: { "key": "<base64-or-hex-encoded-32-byte-key>" }
 */
@Injectable()
export class AwsSecretsManagerEncryptionKeyProvider
    implements EncryptionKeyProvider
{
    readonly name = "aws";
    private readonly logger = new Logger(
        AwsSecretsManagerEncryptionKeyProvider.name,
    );
    private readonly client: SecretsManagerClient;
    private readonly secretName: string;
    private readonly secretKey: string;

    constructor(private readonly configService: ConfigService) {
        const region = this.configService.get<string>("AWS_REGION");
        if (!region) {
            throw new Error(
                "AWS_REGION is required when using AWS Secrets Manager encryption key source",
            );
        }

        this.secretName = this.configService.get<string>(
            "AWS_ENCRYPTION_SECRET_NAME",
        ) as string;
        if (!this.secretName) {
            throw new Error(
                "AWS_ENCRYPTION_SECRET_NAME is required when using AWS Secrets Manager encryption key source",
            );
        }

        // Optional: key name within JSON secret (defaults to "key")
        this.secretKey =
            this.configService.get<string>("AWS_ENCRYPTION_SECRET_KEY") ||
            "key";

        this.client = new SecretsManagerClient({
            region,
            // AWS SDK automatically uses IAM roles when running in AWS
            // Or falls back to AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars
        });
    }

    async getKey(): Promise<Buffer> {
        this.logger.log(
            `Fetching encryption key from AWS Secrets Manager: ${this.secretName}`,
        );

        try {
            const command = new GetSecretValueCommand({
                SecretId: this.secretName,
            });
            const response = await this.client.send(command);

            let keyData: string;

            if (response.SecretString) {
                const jsonSecret = parseJsonObject(response.SecretString);
                if (jsonSecret) {
                    const field = jsonSecret[this.secretKey];
                    keyData = typeof field === "string" ? field : "";
                    if (!keyData) {
                        throw new Error(
                            `Secret JSON does not contain key "${this.secretKey}"`,
                        );
                    }
                } else {
                    // Not a JSON object, treat as plain text key
                    keyData = response.SecretString;
                }
            } else if (response.SecretBinary) {
                // Binary secret - assume it's the raw key bytes
                const binaryKey =
                    response.SecretBinary instanceof Uint8Array
                        ? Buffer.from(response.SecretBinary)
                        : Buffer.from(
                              response.SecretBinary as string,
                              "base64",
                          );

                if (binaryKey.length === 32) {
                    this.logger.log(
                        `Encryption key loaded from AWS (fingerprint: ${this.fingerprint(binaryKey)})`,
                    );
                    return binaryKey;
                }
                throw new Error(
                    `Invalid binary secret length: expected 32 bytes, got ${binaryKey.length}`,
                );
            } else {
                throw new Error("Secret has no value");
            }

            // Decode the key (support base64 and hex)
            let keyBuffer: Buffer;
            if (keyData.length === 64 && /^[0-9a-fA-F]+$/.test(keyData)) {
                // Hex-encoded 32 bytes = 64 characters
                keyBuffer = Buffer.from(keyData, "hex");
            } else {
                // Assume base64
                keyBuffer = Buffer.from(keyData, "base64");
            }

            if (keyBuffer.length !== 32) {
                throw new Error(
                    `Invalid encryption key length: expected 32 bytes, got ${keyBuffer.length}. ` +
                        `Provide a 256-bit key encoded as base64 (44 chars) or hex (64 chars).`,
                );
            }

            this.logger.log(
                `Encryption key loaded from AWS (fingerprint: ${this.fingerprint(keyBuffer)})`,
            );
            return keyBuffer;
        } catch (error: any) {
            if (error.name === "ResourceNotFoundException") {
                throw new Error(
                    `Encryption key secret not found: ${this.secretName}. ` +
                        `Create it with: aws secretsmanager create-secret --name ${this.secretName} --secret-string $(openssl rand -base64 32)`,
                );
            }
            if (error.name === "AccessDeniedException") {
                throw new Error(
                    `Access denied to secret: ${this.secretName}. ` +
                        `Ensure the IAM role/user has secretsmanager:GetSecretValue permission.`,
                );
            }
            throw new Error(
                `Failed to fetch encryption key from AWS Secrets Manager: ${error.message}`,
            );
        }
    }

    /**
     * Generate a safe fingerprint of the key for logging (first 8 chars of SHA-256 hash).
     */
    private fingerprint(key: Buffer): string {
        return createHash("sha256").update(key).digest("hex").substring(0, 8);
    }
}

/**
 * Parses a secret string as a JSON object. A plain key, including a hex key
 * that JSON reads as a number, gives undefined.
 */
function parseJsonObject(value: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed !== null && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}
