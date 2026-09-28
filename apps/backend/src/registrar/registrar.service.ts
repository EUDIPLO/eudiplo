import { Injectable } from "@nestjs/common";
import { TenantEntity } from "../auth/tenant/entities/tenant.entity.js";
import { AccessCertificateService } from "./access-certificate.service.js";
import { RegistrarConfigEntity } from "./entities/registrar-config.entity.js";
import { type RegistrationCertificateCreation } from "./generated/index.js";
import { RegistrarConfigService } from "./registrar-config.service.js";
import { RegistrationCertificateService } from "./registration-certificate.service.js";
import { SchemaMetadataService } from "./schema-metadata/schema-metadata.service.js";
import type {
    CreateAccessCertificate,
    CreateRegistrarConfig,
    UpdateRegistrarConfig,
} from "./schemas/registrar.schema.js";

/**
 * Facade that preserves the original public API of the registrar domain.
 * Actual logic lives in the focused sub-services:
 *  - {@link RegistrarConfigService}   — config CRUD and file-based import
 *  - {@link RegistrarAuthService}     — OAuth token management and API client
 *  - {@link RegistrationCertificateService} — registration cert lifecycle + DCQL fingerprints
 *  - {@link AccessCertificateService} — access certificate creation
 */
@Injectable()
export class RegistrarService {
    constructor(
        private readonly configSvc: RegistrarConfigService,
        private readonly regCertSvc: RegistrationCertificateService,
        private readonly accessCertSvc: AccessCertificateService,
        private readonly schemaMetadataSvc: SchemaMetadataService,
    ) {}

    // -------------------------------------------------------------------------
    // Config delegation → RegistrarConfigService
    // -------------------------------------------------------------------------

    isEnabledForTenant(tenantId: string): Promise<boolean> {
        return this.configSvc.isEnabledForTenant(tenantId);
    }

    onTenantInit(tenant: Pick<TenantEntity, "id" | "name">): Promise<void> {
        return this.configSvc.onTenantInit(tenant);
    }

    getConfig(tenantId: string): Promise<RegistrarConfigEntity | null> {
        return this.configSvc.getConfig(tenantId);
    }

    saveConfig(
        tenantId: string,
        dto: CreateRegistrarConfig,
    ): Promise<RegistrarConfigEntity> {
        return this.configSvc.saveConfig(tenantId, dto);
    }

    updateConfig(
        tenantId: string,
        dto: UpdateRegistrarConfig,
    ): Promise<RegistrarConfigEntity> {
        return this.configSvc.updateConfig(tenantId, dto);
    }

    deleteConfig(tenantId: string): Promise<void> {
        return this.configSvc.deleteConfig(tenantId);
    }

    // -------------------------------------------------------------------------
    // Access certificate delegation → AccessCertificateService
    // -------------------------------------------------------------------------

    createAccessCertificate(
        tenantId: string,
        dto: CreateAccessCertificate,
    ): Promise<{ id: string; certId: string; crt: string }> {
        return this.accessCertSvc.createAccessCertificate(tenantId, dto);
    }

    // -------------------------------------------------------------------------
    // Registration certificate delegation → RegistrationCertificateService
    // -------------------------------------------------------------------------

    addRegistrationCertificate(
        req: {
            id?: string;
            body?: Partial<RegistrationCertificateCreation>;
            jwt?: string;
        },
        dcqlQuery: any,
        requestId: string,
        tenantId: string,
    ): Promise<string> {
        return this.regCertSvc.addRegistrationCertificate(
            req,
            dcqlQuery,
            requestId,
            tenantId,
        );
    }

    resolveRegistrationCertificate(
        req: {
            id?: string;
            body?: Partial<RegistrationCertificateCreation>;
            jwt?: string;
        },
        dcqlQuery: any,
        requestId: string,
        tenantId: string,
    ): Promise<{
        jwt: string;
        payload: Record<string, any>;
        source: "imported" | "registrar";
    }> {
        return this.regCertSvc.resolveRegistrationCertificate(
            req,
            dcqlQuery,
            requestId,
            tenantId,
        );
    }

    revokeRegistrationCertificateByJwt(
        tenantId: string,
        jwt: string,
    ): Promise<boolean> {
        return this.regCertSvc.revokeRegistrationCertificateByJwt(
            tenantId,
            jwt,
        );
    }

    computeDcqlFingerprint(dcqlQuery: any): string {
        return this.regCertSvc.computeDcqlFingerprint(dcqlQuery);
    }

    computeAuthorizedCredentialsFingerprint(credentials: unknown): string {
        return this.regCertSvc.computeAuthorizedCredentialsFingerprint(
            credentials,
        );
    }

    computeSpecFingerprint(spec: unknown): string {
        return this.regCertSvc.computeSpecFingerprint(spec);
    }

    // -------------------------------------------------------------------------
    // Schema metadata list lookup used by verifier/catalog flows.
    // -------------------------------------------------------------------------

    findAllSchemaMetadata(
        tenantId: string,
        filters: { attestationId?: string; version?: string },
    ) {
        return this.schemaMetadataSvc.findAll(tenantId, filters);
    }
}
