import { createVerify, X509Certificate } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import * as eudiAttestationSchema from "@owf/eudi-attestation-schema";
import { type AttestationFormat } from "@owf/eudi-attestation-schema";
import { base64url, decodeJwt, decodeProtectedHeader } from "jose";
import { RegistrarService } from "../../../registrar/registrar.service.js";
import { MetadataFetchService } from "./metadata-fetch.service.js";

type BuildDcqlFromSchemaMetaResult = {
    credentials: Array<Record<string, unknown>>;
};

type ResolvedSchemaMetadataPayload = {
    id: string;
    version?: string;
    name?: string;
    description?: string;
    category?: string;
    tags?: string[];
    supportedFormats: string[];
    schemaURIs: Array<{
        formatIdentifier?: string;
        format?: string;
        uri?: string;
    }>;
    trustedAuthorities: Array<{
        frameworkType?: string;
        value?: string;
        isLoTE?: boolean;
    }>;
    resolvedReferences: Array<{
        format: string;
        uri: string;
        integrity?: string;
        meta?: Record<string, unknown>;
        parsedSchema?: Record<string, unknown>;
    }>;
    dcqlQuery: BuildDcqlFromSchemaMetaResult;
};

type ResolvedSchemaMetadata = {
    signedJwt: string;
    schema: ResolvedSchemaMetadataPayload;
};

type SchemaMetadataVerifier = (
    data: string,
    signature: string,
) => Promise<boolean>;

type SchemaMetaPayload = {
    id?: string;
    version?: string;
    schemaURIs: Array<{ formatIdentifier?: string; uri: string }>;
    trustedAuthorities?: Array<{
        frameworkType?: string;
        value?: string;
        isLOTE?: boolean;
    }>;
};

type ResolvedSchemaReference = {
    format: string;
    uri: string;
    integrity?: string;
    meta?: unknown;
    parsedSchema?: Record<string, unknown>;
};

type VerifiedSchemaMeta = {
    verified: { payload: SchemaMetaPayload };
    resolvedReferences: ResolvedSchemaReference[];
    dcql: BuildDcqlFromSchemaMetaResult;
};

/**
 * The installed `@owf/eudi-attestation-schema` either offers the combined
 * `verifyResolveAndBuildDcql` or the three individual steps.
 */
type SchemaMetaSdkCompat = {
    verifyResolveAndBuildDcql?: (options: {
        jws: string;
        verifier: SchemaMetadataVerifier;
        selectedFormats: AttestationFormat[];
        resolve: (uri: string) => Promise<{ content: string | object }>;
        verifyIntegrity?: boolean;
        includeTrustedAuthorities?: boolean;
    }) => Promise<VerifiedSchemaMeta>;
    verifySchemaMeta?: (options: {
        jws: string;
        verifier: SchemaMetadataVerifier;
    }) => Promise<{ payload: SchemaMetaPayload }>;
    resolveSchemaReferences?: (options: {
        schemaMeta: unknown;
        selectedFormats: AttestationFormat[];
        resolve: (uri: string) => Promise<{ content: string | object }>;
    }) => Promise<ResolvedSchemaReference[]>;
    buildDcqlFromSchemaMeta?: (options: {
        schemaMeta: unknown;
        selectedFormats: AttestationFormat[];
        resolvedReferences?: ResolvedSchemaReference[];
        includeTrustedAuthorities?: boolean;
    }) => BuildDcqlFromSchemaMetaResult;
};

/**
 * Resolves external issuer and schema metadata for building presentation
 * configurations in the management UI. All outbound requests go through
 * {@link MetadataFetchService}, which enforces the SSRF policy.
 */
@Injectable()
export class MetadataImportService {
    constructor(
        private readonly metadataFetchService: MetadataFetchService,
        private readonly registrarService: RegistrarService,
    ) {}

    /**
     * Resolve OID4VCI credential issuer metadata server-side.
     * This is used by the web client to avoid browser CORS restrictions.
     */
    async resolveCredentialIssuerMetadata(issuerUrl: string) {
        const metadataUrl =
            this.metadataFetchService.buildCredentialIssuerMetadataUrl(
                issuerUrl,
            );
        const metadata = await this.metadataFetchService.fetch(metadataUrl);

        if (!metadata || typeof metadata !== "object") {
            throw new BadRequestException(
                `Issuer metadata response from ${metadataUrl} is invalid`,
            );
        }

        return metadata;
    }

    /**
     * List schema metadata entries from the connected registrar catalog.
     * Returns an empty array when the registrar is not enabled for the tenant.
     */
    async listSchemaMetadataCatalog(tenantId: string) {
        const enabled =
            await this.registrarService.isEnabledForTenant(tenantId);
        if (!enabled) {
            return [];
        }
        return this.registrarService.findAllSchemaMetadata(tenantId, {});
    }

    /**
     * Resolve schema metadata from a URL and verify its signed JWT.
     * Returns normalized fields that can be used to build a DCQL query.
     */
    async resolveSchemaMetadata(
        schemaMetadataUrl: string,
    ): Promise<ResolvedSchemaMetadata> {
        const response =
            await this.metadataFetchService.fetch(schemaMetadataUrl);

        if (!response || typeof response !== "object") {
            throw new BadRequestException(
                `Schema metadata response from ${schemaMetadataUrl} is invalid`,
            );
        }

        const signedJwt =
            typeof (response as { signedJwt?: unknown }).signedJwt === "string"
                ? (response as { signedJwt: string }).signedJwt
                : undefined;

        if (!signedJwt) {
            throw new BadRequestException(
                "Schema metadata response does not contain a signedJwt field",
            );
        }

        const responseMetadata = response as {
            name?: unknown;
            description?: unknown;
            category?: unknown;
            tags?: unknown;
        };

        return this.verifyAndResolve(signedJwt, {
            name:
                typeof responseMetadata.name === "string"
                    ? responseMetadata.name
                    : undefined,
            description:
                typeof responseMetadata.description === "string"
                    ? responseMetadata.description
                    : undefined,
            category:
                typeof responseMetadata.category === "string"
                    ? responseMetadata.category
                    : undefined,
            tags: Array.isArray(responseMetadata.tags)
                ? responseMetadata.tags.filter(
                      (tag): tag is string => typeof tag === "string",
                  )
                : undefined,
        });
    }

    /**
     * Resolve a signed schema metadata JWT directly (e.g. a catalog entry).
     */
    async resolveSchemaMetadataJwt(
        signedJwt: string,
    ): Promise<ResolvedSchemaMetadata> {
        if (!signedJwt || typeof signedJwt !== "string") {
            throw new BadRequestException(
                "signedJwt must be a non-empty string",
            );
        }

        return this.verifyAndResolve(signedJwt, {});
    }

    /**
     * Verify the schema metadata JWT against its x5c leaf certificate, resolve
     * the referenced schemas and build the DCQL query.
     */
    private async verifyAndResolve(
        signedJwt: string,
        descriptiveFields: Pick<
            ResolvedSchemaMetadataPayload,
            "name" | "description" | "category" | "tags"
        >,
    ): Promise<ResolvedSchemaMetadata> {
        const allFormats = deriveSchemaMetadataFormatsFromJwt(signedJwt);

        if (allFormats.length === 0) {
            throw new BadRequestException(
                "Schema metadata JWT payload does not contain any supported formats",
            );
        }

        const verifier = buildSchemaMetadataVerifier(signedJwt);
        const selectedFormats = allFormats as AttestationFormat[];
        const resolve = async (uri: string) => ({
            content: await this.metadataFetchService.fetch(uri),
        });
        const schemaMetaSdk =
            eudiAttestationSchema as unknown as SchemaMetaSdkCompat;
        const resolved =
            typeof schemaMetaSdk.verifyResolveAndBuildDcql === "function"
                ? await schemaMetaSdk.verifyResolveAndBuildDcql({
                      jws: signedJwt,
                      verifier,
                      selectedFormats,
                      resolve,
                      includeTrustedAuthorities: true,
                  })
                : await verifyResolveAndBuildDcqlInSteps(
                      schemaMetaSdk,
                      signedJwt,
                      verifier,
                      selectedFormats,
                      resolve,
                  );

        const payload = resolved.verified.payload;
        const id = typeof payload.id === "string" ? payload.id : undefined;
        if (!id) {
            throw new BadRequestException(
                "Schema metadata JWT payload is missing a valid id",
            );
        }

        return {
            signedJwt,
            schema: {
                id,
                version: payload.version,
                ...descriptiveFields,
                supportedFormats: allFormats,
                schemaURIs: payload.schemaURIs.map((entry) => ({
                    formatIdentifier: entry.formatIdentifier,
                    uri: entry.uri,
                })),
                trustedAuthorities:
                    payload.trustedAuthorities?.map((authority) => ({
                        frameworkType: authority.frameworkType,
                        value: authority.value,
                        isLoTE: authority.isLOTE,
                    })) ?? [],
                resolvedReferences: resolved.resolvedReferences.map((ref) => ({
                    format: ref.format,
                    uri: ref.uri,
                    integrity: ref.integrity,
                    meta:
                        ref.meta && typeof ref.meta === "object"
                            ? (ref.meta as Record<string, unknown>)
                            : undefined,
                    parsedSchema: ref.parsedSchema,
                })),
                dcqlQuery: resolved.dcql,
            },
        };
    }
}

async function verifyResolveAndBuildDcqlInSteps(
    schemaMetaSdk: SchemaMetaSdkCompat,
    signedJwt: string,
    verifier: SchemaMetadataVerifier,
    selectedFormats: AttestationFormat[],
    resolve: (uri: string) => Promise<{ content: string | object }>,
): Promise<VerifiedSchemaMeta> {
    if (
        typeof schemaMetaSdk.verifySchemaMeta !== "function" ||
        typeof schemaMetaSdk.resolveSchemaReferences !== "function" ||
        typeof schemaMetaSdk.buildDcqlFromSchemaMeta !== "function"
    ) {
        throw new BadRequestException(
            "Installed @owf/eudi-attestation-schema version does not support schema metadata resolution APIs",
        );
    }

    const verified = await schemaMetaSdk.verifySchemaMeta({
        jws: signedJwt,
        verifier,
    });
    const resolvedReferences = await schemaMetaSdk.resolveSchemaReferences({
        schemaMeta: verified.payload,
        selectedFormats,
        resolve,
    });
    const dcql = schemaMetaSdk.buildDcqlFromSchemaMeta({
        schemaMeta: verified.payload,
        selectedFormats,
        resolvedReferences,
        includeTrustedAuthorities: true,
    });

    return { verified, resolvedReferences, dcql };
}

function deriveSchemaMetadataFormatsFromJwt(signedJwt: string): string[] {
    let payload: Record<string, unknown>;

    try {
        payload = decodeJwt(signedJwt) as Record<string, unknown>;
    } catch {
        throw new BadRequestException(
            "signedJwt in schema metadata response is not a valid JWT",
        );
    }

    const supportedFormats = Array.isArray(payload.supportedFormats)
        ? payload.supportedFormats.filter(
              (format): format is string => typeof format === "string",
          )
        : [];

    const schemaURIs = Array.isArray(payload.schemaURIs)
        ? (payload.schemaURIs as Array<{
              formatIdentifier?: string;
              format?: string;
          }>)
        : [];

    const schemaUriFormats = schemaURIs
        .map((entry) => entry.formatIdentifier ?? entry.format)
        .filter((format): format is string => typeof format === "string");

    return Array.from(new Set([...supportedFormats, ...schemaUriFormats]));
}

function buildSchemaMetadataVerifier(
    signedJwt: string,
): SchemaMetadataVerifier {
    const header = decodeProtectedHeader(signedJwt);
    const x5c = Array.isArray(header.x5c)
        ? header.x5c.filter((cert): cert is string => typeof cert === "string")
        : [];

    if (x5c.length === 0) {
        throw new BadRequestException(
            "Schema metadata JWT does not contain x5c certificate chain in header",
        );
    }

    const leafCert = new X509Certificate(Buffer.from(x5c[0], "base64"));
    const key = leafCert.publicKey;
    const alg = typeof header.alg === "string" ? header.alg : "ES256";

    return async (data: string, signature: string) => {
        try {
            const verifier = createVerify("SHA256");
            verifier.update(data);
            verifier.end();

            const signatureBytes = Buffer.from(base64url.decode(signature));
            if (alg.startsWith("ES")) {
                return verifier.verify(
                    { key, dsaEncoding: "ieee-p1363" },
                    signatureBytes,
                );
            }

            return verifier.verify(key, signatureBytes);
        } catch {
            return false;
        }
    };
}
