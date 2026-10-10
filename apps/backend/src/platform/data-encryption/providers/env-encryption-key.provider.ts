import { hkdfSync } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EncryptionKeyProvider } from "./encryption-key-provider.interface.js";

/**
 * Default encryption key provider.
 * Derives the encryption key from MASTER_SECRET using HKDF, so no external
 * secret store is needed.
 *
 * Whoever has MASTER_SECRET and the database can decrypt the stored data, and
 * changing MASTER_SECRET makes it unreadable. The vault, aws and azure
 * providers are an optional alternative that keeps the key out of the
 * process environment.
 */
@Injectable()
export class EnvEncryptionKeyProvider implements EncryptionKeyProvider {
    readonly name = "env";
    private readonly logger = new Logger(EnvEncryptionKeyProvider.name);

    constructor(private readonly configService: ConfigService) {}

    async getKey(): Promise<Buffer> {
        const masterSecret = this.configService.get<string>("MASTER_SECRET");
        if (!masterSecret) {
            throw new Error(
                "MASTER_SECRET is required when using env encryption key source",
            );
        }

        this.logger.log(
            "Deriving the data-at-rest encryption key from MASTER_SECRET. " +
                "Changing MASTER_SECRET makes encrypted data unreadable.",
        );

        // Derive a 256-bit encryption key from MASTER_SECRET using HKDF
        return Buffer.from(
            hkdfSync(
                "sha256",
                masterSecret,
                "", // salt - empty for simplicity
                "eudiplo-encryption-at-rest", // info - context string
                32, // 256 bits
            ),
        );
    }
}
