import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    Injectable,
    Logger,
    type OnApplicationBootstrap,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { kmsConfigFilePath } from "../../crypto/key/kms/kms-config-file.js";
import { ConfigImportModeService } from "../config-import/config-import-mode.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigOwnershipService } from "./config-ownership.service.js";

@Injectable()
export class ConfigOwnershipBootstrapService implements OnApplicationBootstrap {
    private readonly logger = new Logger(ConfigOwnershipBootstrapService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly ownershipService: ConfigOwnershipService,
        private readonly migrationService: ConfigMigrationService,
        private readonly importModeService: ConfigImportModeService,
        @InjectRepository(TenantEntity)
        private readonly tenants: Repository<TenantEntity>,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (this.importModeService.resolve() === "disabled") return;
        const configFolder = this.configService.get<string>("CONFIG_FOLDER");
        if (!configFolder) return;
        for (const tenant of await this.tenants.find({
            select: { id: true },
        })) {
            const file = kmsConfigFilePath(configFolder, tenant.id);
            if (!file) {
                this.logger.warn(
                    `[${tenant.id}] The tenant ID is not a folder name, so the tenant has no configuration folder: it uses the global kms.json and cannot reattach resources. Move its configuration to a tenant with a valid ID.`,
                );
                continue;
            }
            if (
                !existsSync(file) ||
                (await this.ownershipService.findStored(
                    tenant.id,
                    "KmsConfig",
                    "kms",
                ))
            ) {
                continue;
            }
            const raw = readFileSync(file);
            let document: ReturnType<ConfigMigrationService["wrapLegacy"]>;
            try {
                const payload = JSON.parse(raw.toString("utf8"));
                document = this.migrationService.isDocument(payload)
                    ? this.migrationService.upgrade(payload).document
                    : this.migrationService.wrapLegacy(
                          "KmsConfig",
                          payload,
                          "kms",
                      );
            } catch {
                // One tenant's file must not stop the startup of the others.
                // Without the reason: the message of the JSON parser quotes
                // the file, which holds credentials. The tenant's key
                // operations report the reason when they load the file.
                this.logger.warn(
                    `[${tenant.id}] ${file} is not JSON or no configuration document the backend can read, so it is not recorded as the tenant's file-managed KMS configuration. The tenant's key operations fail until the file is valid.`,
                );
                continue;
            }
            await this.ownershipService.markApplied({
                tenantId: tenant.id,
                kind: "KmsConfig",
                resourceId: "kms",
                ownership: "file-managed",
                generation: document.metadata.generation ?? 1,
                source: `folder:${dirname(file)}`,
                sourceHash: createHash("sha256").update(raw).digest("hex"),
            });
        }
    }
}
