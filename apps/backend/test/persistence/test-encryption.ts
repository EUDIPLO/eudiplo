import { DataEncryptionService } from "../../src/platform/data-encryption/data-encryption.service.js";
import { initializeEncryptionTransformer } from "../../src/platform/data-encryption/encrypted-column.transformer.js";

/** Initialize the encrypted column transformers with a fixed test key. */
export async function initializeTestEncryption() {
    const encryption = new DataEncryptionService({
        name: "contract-test",
        getKey: async () => Buffer.alloc(32, 7),
    });
    await encryption.initialize();
    initializeEncryptionTransformer(encryption);
}
