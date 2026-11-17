import { X509Certificate } from "node:crypto";
import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    OutboundFetchError,
    outboundFetch,
} from "../../webhook/outbound-fetch.js";
import { OutboundUrlPolicyService } from "../../webhook/outbound-url-policy.service.js";
import type {
    EudiHubCredential,
    EudiHubText,
} from "./domain/hub-credentials.js";

/**
 * Limits for every request to the EUDI Hub: one deadline per request
 * including redirects and body, a response size cap, and a few redirects,
 * each checked against the outbound URL policy.
 */
const EUDI_HUB_REQUEST_LIMITS = {
    timeoutMs: 30_000,
    maxBytes: 1024 * 1024,
    maxRedirects: 3,
};

/** Longest problem detail of the EUDI Hub passed on to the caller. */
const MAX_DETAIL_LENGTH = 300;

/** Environment of the EUDI Hub a certificate is issued for. */
export type EudiHubEnvironment = "sandbox" | "live";

/** An organization the token's user is assigned to. */
export interface EudiHubOrganization {
    id: string;
    name: string;
}

/** An access certificate as the EUDI Hub tracks it. */
export interface EudiHubAccessCertificate {
    id: string;
    name: string;
    status: "valid" | "expired" | "revoked";
    environment: EudiHubEnvironment;
    createdAt: string;
    expirationDate: string;
    clientId: string;
}

/** Official identifier of an organization (ETSI TS 119 475). */
interface EudiHubIdentifier {
    type: string;
    value: string;
}

/** What the EUDI Hub knows about an organization that a registration certificate needs. */
export interface EudiHubOrganizationDetails {
    id: string;
    name: string;
    identifiers: EudiHubIdentifier[];
    serviceDescriptions: { name: string; descriptions: EudiHubText[] }[];
    privacyPolicyUris: string[];
    supportUris: string[];
    infoUris: string[];
}

/** A credential request (intended use) of a verifier. */
export interface EudiHubCredentialRequest {
    id: string;
    name: string;
    purpose: EudiHubText[];
    credentials: EudiHubCredential[];
    privacyPolicy: string;
    environments: EudiHubEnvironment[];
}

/** A credential type an issuer issues. */
export interface EudiHubCredentialIssuance {
    id: string;
    name: string;
    credential: EudiHubCredential;
    environments: EudiHubEnvironment[];
}

/** Fields every registration certificate needs. */
export interface EudiHubRegistrationCertificateBase {
    name: string;
    environment: EudiHubEnvironment;
    identifier: EudiHubIdentifier;
    serviceDescription: EudiHubText[];
    supportUri: string;
    infoUri: string;
}

/** A registration certificate as the EUDI Hub tracks it. */
export interface EudiHubRegistrationCertificate {
    id: string;
    name: string;
    status: "valid" | "expired" | "revoked";
    environment: EudiHubEnvironment;
    expirationDate?: string;
}

/** What is known about a failed request to the EUDI Hub. */
export interface EudiHubRequestErrorOptions {
    /** HTTP status of an answer outside 2xx; undefined when no such answer arrived. */
    status?: number;
    /** Problem detail of the answer (RFC 9457), shortened, or why the request failed. */
    detail?: string;
    /** The outbound URL policy refused the request. */
    blocked?: boolean;
    /** A 2xx answer that is not what the EUDI Hub API describes. */
    invalidAnswer?: boolean;
}

/** A request to the EUDI Hub that failed. The message never contains the token. */
export class EudiHubRequestError extends Error {
    readonly status?: number;
    readonly detail?: string;
    readonly blocked: boolean;
    readonly invalidAnswer: boolean;

    constructor(message: string, options: EudiHubRequestErrorOptions = {}) {
        super(message);
        this.name = "EudiHubRequestError";
        this.status = options.status;
        this.detail = options.detail;
        this.blocked = options.blocked ?? false;
        this.invalidAnswer = options.invalidAnswer ?? false;
    }
}

/** An error for a 2xx answer that does not match the EUDI Hub API. */
function invalidAnswer(message: string): EudiHubRequestError {
    return new EudiHubRequestError(message, { invalidAnswer: true });
}

/**
 * Client for the Organization API of the German EUDI Hub. Every call takes
 * the access token of the portal user; the client keeps no token, so it
 * exists only for the request it was pasted for.
 */
@Injectable()
export class EudiHubClient {
    private readonly fetch: typeof fetch;
    private readonly baseUrl: string;

    constructor(
        configService: ConfigService,
        outboundUrlPolicy: OutboundUrlPolicyService,
        http: HttpService,
    ) {
        this.fetch = outboundFetch(
            http,
            outboundUrlPolicy,
            EUDI_HUB_REQUEST_LIMITS,
        );
        // The validation schema sets the default.
        let baseUrl = configService.getOrThrow<string>("EUDI_HUB_API_URL");
        while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
        this.baseUrl = baseUrl;
    }

    /** The organizations the user of the token is assigned to. */
    async listOrganizations(token: string): Promise<EudiHubOrganization[]> {
        const body = await this.json<{ organizations?: unknown }>(
            token,
            "GET",
            "/v1/me",
        );
        if (!Array.isArray(body.organizations)) {
            throw invalidAnswer(
                "The EUDI Hub answered without a list of organizations",
            );
        }
        return body.organizations
            .filter(
                (entry): entry is EudiHubOrganization =>
                    typeof entry?.id === "string" &&
                    typeof entry?.name === "string",
            )
            .map(({ id, name }) => ({ id, name }));
    }

    /** Request an access certificate for a PEM CSR. */
    async createAccessCertificate(
        token: string,
        organizationId: string,
        body: {
            name: string;
            csr: string;
            environment: EudiHubEnvironment;
            supportUri: string;
        },
    ): Promise<EudiHubAccessCertificate> {
        const certificate = await this.json(
            token,
            "POST",
            `${this.organizationPath(organizationId)}/access-certificates`,
            body,
        );
        return this.checkedCertificate(certificate);
    }

    /** The first page of the organization's access certificates in an environment. */
    async listAccessCertificates(
        token: string,
        organizationId: string,
        environment: EudiHubEnvironment,
    ): Promise<EudiHubAccessCertificate[]> {
        return (
            await this.listPage(
                token,
                `${this.organizationPath(organizationId)}/access-certificates`,
                environment,
                "access certificates",
            )
        ).map((item) => this.checkedCertificate(item));
    }

    /** The certificate in PEM format; the EUDI Hub hands out DER. */
    async downloadAccessCertificate(
        token: string,
        organizationId: string,
        certificateId: string,
    ): Promise<string> {
        const response = await this.request(
            token,
            "GET",
            `${this.organizationPath(organizationId)}/access-certificates/${encodeURIComponent(certificateId)}/download`,
        );
        const der = Buffer.from(await response.arrayBuffer());
        try {
            return new X509Certificate(der).toString();
        } catch {
            throw invalidAnswer(
                `The EUDI Hub answered the download of access certificate ${certificateId} without a certificate`,
            );
        }
    }

    /** Revoke an access certificate right away. */
    async revokeAccessCertificate(
        token: string,
        organizationId: string,
        certificateId: string,
    ): Promise<void> {
        await this.request(
            token,
            "POST",
            `${this.organizationPath(organizationId)}/access-certificates/${encodeURIComponent(certificateId)}/revoke`,
            { revocationReason: "cessationOfOperation" },
        );
    }

    /** Legal and contact data of an organization, for a registration certificate. */
    async getOrganization(
        token: string,
        organizationId: string,
    ): Promise<EudiHubOrganizationDetails> {
        const organization = await this.json<Record<string, any>>(
            token,
            "GET",
            this.organizationPath(organizationId),
        );
        if (typeof organization?.id !== "string") {
            throw invalidAnswer(
                "The EUDI Hub answered without an organization",
            );
        }
        const strings = (value: unknown): string[] =>
            Array.isArray(value)
                ? value.filter(
                      (item): item is string => typeof item === "string",
                  )
                : [];
        const identifier = organization.legalInformation?.identifier;
        const identifiers = (
            Array.isArray(identifier) ? identifier : [identifier]
        )
            .filter(
                (entry): entry is EudiHubIdentifier =>
                    typeof entry?.type === "string" &&
                    typeof entry?.value === "string",
            )
            .map(({ type, value }) => ({ type, value }));
        const serviceDescriptions = (
            Array.isArray(organization.serviceDescription)
                ? organization.serviceDescription
                : []
        )
            .filter(
                (entry: any) =>
                    typeof entry?.name === "string" &&
                    Array.isArray(entry?.descriptions),
            )
            .map((entry: any) => ({
                name: entry.name as string,
                descriptions: texts(entry.descriptions),
            }));
        return {
            id: organization.id,
            name:
                typeof organization.tradeName === "string"
                    ? organization.tradeName
                    : String(organization.name ?? ""),
            identifiers,
            serviceDescriptions,
            privacyPolicyUris: strings(
                organization.legalInformation?.privacyPolicyUris,
            ),
            supportUris: strings(organization.contactInformation?.supportUris),
            infoUris: strings(organization.contactInformation?.infoUris),
        };
    }

    /** The first page of the organization's credential requests in an environment. */
    async listCredentialRequests(
        token: string,
        organizationId: string,
        environment: EudiHubEnvironment,
    ): Promise<EudiHubCredentialRequest[]> {
        return (
            await this.listPage(
                token,
                `${this.organizationPath(organizationId)}/credential-requests`,
                environment,
                "credential requests",
            )
        ).filter(hasId) as EudiHubCredentialRequest[];
    }

    /** Register what a verifier requests from wallets, and why. */
    async createCredentialRequest(
        token: string,
        organizationId: string,
        body: Omit<EudiHubCredentialRequest, "id">,
    ): Promise<EudiHubCredentialRequest> {
        return this.checkedWithId(
            await this.json(
                token,
                "POST",
                `${this.organizationPath(organizationId)}/credential-requests`,
                body,
            ),
        );
    }

    /** The first page of the organization's credential issuances in an environment. */
    async listCredentialIssuances(
        token: string,
        organizationId: string,
        environment: EudiHubEnvironment,
    ): Promise<EudiHubCredentialIssuance[]> {
        return (
            await this.listPage(
                token,
                `${this.organizationPath(organizationId)}/credential-issuances`,
                environment,
                "credential issuances",
            )
        ).filter(hasId) as EudiHubCredentialIssuance[];
    }

    /** Register a credential type an issuer issues. */
    async createCredentialIssuance(
        token: string,
        organizationId: string,
        body: Omit<EudiHubCredentialIssuance, "id">,
    ): Promise<EudiHubCredentialIssuance> {
        return this.checkedWithId(
            await this.json(
                token,
                "POST",
                `${this.organizationPath(organizationId)}/credential-issuances`,
                body,
            ),
        );
    }

    /** Create a registration certificate for a credential request or credential issuances. */
    async createRegistrationCertificate(
        token: string,
        organizationId: string,
        body: EudiHubRegistrationCertificateBase &
            (
                | { type: "credentialRequest"; credentialRequestId: string }
                | {
                      type: "credentialIssuance";
                      credentialIssuanceIds: string[];
                  }
            ),
    ): Promise<EudiHubRegistrationCertificate> {
        return this.checkedWithId(
            await this.json(
                token,
                "POST",
                `${this.organizationPath(organizationId)}/registration-certificates`,
                body,
            ),
        );
    }

    /** The registration certificate as a JWT (JWS compact serialization). */
    async downloadRegistrationCertificate(
        token: string,
        organizationId: string,
        certificateId: string,
    ): Promise<string> {
        const response = await this.request(
            token,
            "GET",
            `${this.organizationPath(organizationId)}/registration-certificates/${encodeURIComponent(certificateId)}/download`,
        );
        const jwt = (await response.text()).trim();
        if (!isJwt(jwt)) {
            throw invalidAnswer(
                `The EUDI Hub answered the download of registration certificate ${certificateId} without a JWT`,
            );
        }
        return jwt;
    }

    /** Revoke a registration certificate right away. */
    async revokeRegistrationCertificate(
        token: string,
        organizationId: string,
        certificateId: string,
    ): Promise<void> {
        await this.request(
            token,
            "POST",
            `${this.organizationPath(organizationId)}/registration-certificates/${encodeURIComponent(certificateId)}/revoke`,
            { revocationReason: "cessationOfOperation" },
        );
    }

    private async listPage(
        token: string,
        path: string,
        environment: EudiHubEnvironment,
        what: string,
    ): Promise<unknown[]> {
        const query = new URLSearchParams({ environment, limit: "100" });
        const page = await this.json<{ items?: unknown }>(
            token,
            "GET",
            `${path}?${query}`,
        );
        if (!Array.isArray(page.items)) {
            throw invalidAnswer(
                `The EUDI Hub answered without a list of ${what}`,
            );
        }
        return page.items;
    }

    private checkedWithId<T extends { id: string }>(value: unknown): T {
        if (typeof (value as { id?: unknown } | null)?.id !== "string") {
            throw invalidAnswer("The EUDI Hub answered without an id");
        }
        return value as T;
    }

    private organizationPath(organizationId: string): string {
        return `/v1/organizations/${encodeURIComponent(organizationId)}`;
    }

    private async json<T>(
        token: string,
        method: string,
        path: string,
        body?: unknown,
    ): Promise<T> {
        const response = await this.request(token, method, path, body);
        try {
            return (await response.json()) as T;
        } catch {
            throw invalidAnswer(
                `The EUDI Hub answered ${method} ${pathWithoutQuery(path)} without JSON`,
            );
        }
    }

    /**
     * Send one request with the token. Any answer outside 2xx becomes an
     * {@link EudiHubRequestError} with its status and problem detail, as does
     * a request that got no answer.
     */
    private async request(
        token: string,
        method: string,
        path: string,
        body?: unknown,
    ): Promise<Response> {
        const headers: Record<string, string> = {
            authorization: `Bearer ${token}`,
            accept: "application/json, application/problem+json, application/pkix-cert",
        };
        if (body !== undefined) headers["content-type"] = "application/json";

        let response: Response;
        try {
            response = await this.fetch(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (error) {
            if (error instanceof OutboundFetchError) {
                throw new EudiHubRequestError(error.message, {
                    detail: error.detail,
                    blocked: error.blocked,
                });
            }
            throw new EudiHubRequestError(
                `The EUDI Hub could not be reached: ${String(error)}`,
            );
        }
        if (!response.ok) {
            throw new EudiHubRequestError(
                `The EUDI Hub answered ${method} ${pathWithoutQuery(path)} with HTTP ${response.status}`,
                {
                    status: response.status,
                    detail: await this.problemDetail(response),
                },
            );
        }
        return response;
    }

    /** `detail`, else `title`, of a problem answer, shortened; undefined for other answers. */
    private async problemDetail(
        response: Response,
    ): Promise<string | undefined> {
        try {
            const problem = (await response.json()) as {
                detail?: unknown;
                title?: unknown;
            };
            const text = [problem.detail, problem.title].find(
                (value): value is string =>
                    typeof value === "string" && value.trim() !== "",
            );
            return text
                ?.replace(/\s+/g, " ")
                .trim()
                .slice(0, MAX_DETAIL_LENGTH);
        } catch {
            return undefined;
        }
    }

    private checkedCertificate(value: unknown): EudiHubAccessCertificate {
        const certificate = value as Partial<EudiHubAccessCertificate> | null;
        if (
            typeof certificate?.id !== "string" ||
            typeof certificate.name !== "string" ||
            typeof certificate.status !== "string"
        ) {
            throw invalidAnswer(
                "The EUDI Hub answered with an access certificate without id, name or status",
            );
        }
        return certificate as EudiHubAccessCertificate;
    }
}

function pathWithoutQuery(path: string): string {
    return path.split("?")[0];
}

function texts(value: unknown): EudiHubText[] {
    return Array.isArray(value)
        ? value
              .filter(
                  (entry): entry is EudiHubText =>
                      typeof entry?.lang === "string" &&
                      typeof entry?.content === "string",
              )
              .map(({ lang, content }) => ({ lang, content }))
        : [];
}

/** Three base64url parts whose payload is a JSON object, as a compact JWS has. */
function isJwt(value: string): boolean {
    const parts = value.split(".");
    if (
        parts.length !== 3 ||
        !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
    ) {
        return false;
    }
    try {
        const payload: unknown = JSON.parse(
            Buffer.from(parts[1], "base64url").toString("utf8"),
        );
        return typeof payload === "object" && payload !== null;
    } catch {
        return false;
    }
}

/** One entry without an id does not make a whole list unusable. */
function hasId(item: unknown): boolean {
    return typeof (item as { id?: unknown } | null)?.id === "string";
}
