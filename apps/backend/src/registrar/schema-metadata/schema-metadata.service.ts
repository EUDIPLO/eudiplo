import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
} from "@nestjs/common";
import {
    type CreateSchemaMetadataMultipartDto,
    type Schema,
    type SchemaMetadataVocabulariesDto,
    schemaMetadataControllerCreateSchema,
    schemaMetadataControllerFindAll,
    schemaMetadataControllerFindAllByRelyingParty,
    schemaMetadataControllerFindOne,
    schemaMetadataControllerGetInternalMetadata,
    schemaMetadataControllerGetLatestVersionInfo,
    schemaMetadataControllerGetSignedJwt,
    schemaMetadataControllerGetVocabularies,
    schemaMetadataControllerListVersions,
    schemaMetadataControllerRemove,
    schemaMetadataControllerSetVersionDeprecation,
    schemaMetadataControllerUpdateSchema,
} from "../generated/index.js";
import { RegistrarAuthService } from "../registrar-auth.service.js";
import {
    DeprecateSchemaMetadataDto,
    UpdateSchemaMetadataDto,
} from "./dto/schema-metadata.dto.js";

/** Longest registrar error message passed on to the caller. */
const MAX_UPSTREAM_MESSAGE_LENGTH = 500;

type SchemaMetadataFilters = {
    attestationId?: string;
    version?: string;
};

type CreateSchemaMetadataRequest = {
    metadata: CreateSchemaMetadataMultipartDto;
    rulebookFile: Blob | File;
    trustListCertificateFile: Blob | File;
    schemaFiles: Array<Blob | File>;
};

@Injectable()
export class SchemaMetadataService {
    private readonly logger = new Logger(SchemaMetadataService.name);

    constructor(private readonly authService: RegistrarAuthService) {}

    async createSchemaMetadata(
        tenantId: string,
        request: CreateSchemaMetadataRequest,
    ): Promise<Schema> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerCreateSchema({
            client,
            body: {
                schema: JSON.stringify(request.metadata),
                rulebookFile: request.rulebookFile,
                trustListCertificateFile: request.trustListCertificateFile,
                schemaFiles: request.schemaFiles,
            },
        });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "create schema metadata",
                res.error,
            );
        }

        return res.data!;
    }

    async getVocabularies(
        tenantId: string,
    ): Promise<SchemaMetadataVocabulariesDto> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerGetVocabularies({ client });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "get schema metadata vocabularies",
                res.error,
            );
        }

        return res.data!;
    }

    async getMine(tenantId: string): Promise<Schema[]> {
        const client = await this.authService.getClient(tenantId);
        const rpId = await this.authService.getRelyingPartyId(tenantId);
        const res = await schemaMetadataControllerFindAllByRelyingParty({
            client,
            path: {
                rpId,
            },
        });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "list own schema metadata",
                res.error,
            );
        }
        return res.data ?? [];
    }

    async findAll(
        tenantId: string,
        filters: SchemaMetadataFilters,
    ): Promise<Schema[]> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerFindAll({
            client,
            query: {
                ...(filters.attestationId ? { id: filters.attestationId } : {}),
                ...(filters.version ? { version: filters.version } : {}),
            },
        });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "list schema metadata",
                res.error,
            );
        }

        return res.data ?? [];
    }

    async findOne(tenantId: string, id: string): Promise<Schema> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerFindOne({
            client,
            path: { id },
        });

        if (res.error) {
            this.throwUpstreamError(tenantId, "get schema metadata", res.error);
        }

        return res.data!;
    }

    async updateMetadata(
        tenantId: string,
        id: string,
        version: string,
        dto: UpdateSchemaMetadataDto,
    ): Promise<Schema> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerUpdateSchema({
            client,
            path: { id, version },
            body: dto,
        });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "update schema metadata",
                res.error,
            );
        }

        return res.data!;
    }

    async remove(tenantId: string, id: string, version: string): Promise<void> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerRemove({
            client,
            path: { id, version },
        });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "delete schema metadata",
                res.error,
            );
        }
    }

    async getSignedJwt(
        tenantId: string,
        id: string,
        version: string,
    ): Promise<string> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerGetSignedJwt({
            client,
            path: { id, version },
            parseAs: "text",
        });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "get signed schema metadata jwt",
                res.error,
            );
        }

        return res.data as string;
    }

    async getSchemaByFormat(
        tenantId: string,
        id: string,
        version: string,
        format: string,
    ): Promise<unknown> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerGetInternalMetadata({
            client,
            path: { id, version },
        });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "get schema metadata schema",
                res.error,
            );
        }

        const internal = res.data as
            | {
                  schemaFiles?: Array<{
                      formatIdentifier?: string;
                      schemaContent?: unknown;
                  }>;
                  schemaURIs?: Array<{
                      formatIdentifier?: string;
                      schemaContent?: unknown;
                  }>;
              }
            | undefined;

        const fromSchemaFiles = internal?.schemaFiles?.find(
            (entry) => entry.formatIdentifier === format,
        )?.schemaContent;
        if (fromSchemaFiles !== undefined) {
            return fromSchemaFiles;
        }

        const fromSchemaUris = internal?.schemaURIs?.find(
            (entry) => entry.formatIdentifier === format,
        )?.schemaContent;
        if (fromSchemaUris !== undefined) {
            return fromSchemaUris;
        }

        return internal ?? res.data;
    }

    async getLatest(tenantId: string, id: string): Promise<Schema> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerGetLatestVersionInfo({
            client,
            path: { id },
        });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "get latest schema metadata",
                res.error,
            );
        }

        return res.data as Schema;
    }

    async getVersions(tenantId: string, id: string): Promise<Schema[]> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerListVersions({
            client,
            path: { id },
        });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "list schema metadata versions",
                res.error,
            );
        }

        return (res.data ?? []) as Schema[];
    }

    async deprecateVersion(
        tenantId: string,
        id: string,
        version: string,
        dto: DeprecateSchemaMetadataDto,
    ): Promise<Schema> {
        const client = await this.authService.getClient(tenantId);
        const res = await schemaMetadataControllerSetVersionDeprecation({
            client,
            path: { id, version },
            body: dto,
        });

        if (res.error) {
            this.throwUpstreamError(
                tenantId,
                "deprecate schema metadata version",
                res.error,
            );
        }

        return res.data!;
    }

    private throwUpstreamError(
        tenantId: string,
        action: string,
        error: unknown,
    ): never {
        const statusCode = Number(
            (error as any)?.status ?? (error as any)?.statusCode,
        );
        const message = this.upstreamMessage(error);

        this.logger.error(
            { tenantId, action, statusCode, error },
            `Failed to ${action}`,
        );

        if (statusCode === 404) {
            throw new NotFoundException(message);
        }

        if (statusCode === 403) {
            throw new ForbiddenException(message);
        }

        if (statusCode === 400 || statusCode === 401 || statusCode === 409) {
            throw new BadRequestException(message);
        }

        throw new InternalServerErrorException(message);
    }

    /**
     * The registrar's error message for the caller: only a string, and
     * capped in length, so an arbitrary upstream body is never passed on.
     */
    private upstreamMessage(error: unknown): string {
        const candidate = [
            (error as any)?.error?.message,
            (error as any)?.message,
            (error as any)?.error,
        ].find((value) => typeof value === "string" && value.length > 0);
        if (candidate === undefined) {
            return "Unknown registrar error";
        }
        return candidate.length > MAX_UPSTREAM_MESSAGE_LENGTH
            ? `${candidate.slice(0, MAX_UPSTREAM_MESSAGE_LENGTH)}…`
            : candidate;
    }
}
