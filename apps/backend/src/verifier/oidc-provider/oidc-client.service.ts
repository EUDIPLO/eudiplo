import { Inject, Injectable } from "@nestjs/common";
import { v4 } from "uuid";
import type { AuditActionType } from "../../audit-log/audit-action-types.js";
import {
    type AuditLogRequestMeta,
    AuditLogService,
} from "../../audit-log/audit-log.service.js";
import {
    getChangedFields,
    resolveAuditActor,
} from "../../audit-log/audit-log-context.util.js";
import type { TokenPayload } from "../../auth/token.decorator.js";
import { ConflictError } from "../../shared/domain/conflict-error.js";
import { NotFoundError } from "../../shared/domain/not-found-error.js";
import {
    generateClientSecret,
    hashClientSecret,
    MAX_CLIENT_SECRETS,
    type OidcClient,
    type OidcClientScope,
    type OidcClientSecret,
    redirectUriProblem,
    scopesProblem,
} from "./domain/oidc-client.js";
import type { SubjectClaim } from "./domain/presented-claims.js";
import {
    OIDC_PROVIDER_SETTINGS,
    type OidcProviderSettings,
} from "./oidc-provider-settings.js";
import {
    OIDC_CLIENT_REPOSITORY,
    type OidcClientRepository,
} from "./ports/oidc-client.repository.js";
import {
    SIGN_IN_PRESENTATION,
    type SignInPresentation,
} from "./ports/sign-in-presentation.js";
import type {
    CreateOidcClient,
    UpdateOidcClient,
    UpdateOidcClientSecret,
} from "./schemas/oidc-client.schema.js";

class OidcClientNotFound extends NotFoundError {
    constructor(id: string) {
        super(`OpenID Connect client '${id}' not found`);
    }
}

/** A client change the service refuses; mapped to 400 by the controller. */
export class InvalidOidcClient extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidOidcClient";
    }
}

/** The client's secrets do not allow the change. */
class OidcClientSecretConflict extends ConflictError {}

class OidcClientSecretNotFound extends NotFoundError {
    constructor(id: string) {
        super(`Client secret '${id}' not found`);
    }
}

/** Who changed a client, for the audit log. */
export interface OidcClientActor {
    token: TokenPayload;
    requestMeta?: AuditLogRequestMeta;
}

/**
 * Management of the tenant's OpenID Connect clients. Secrets are generated
 * here, returned once and stored only as hashes.
 */
@Injectable()
export class OidcClientService {
    constructor(
        @Inject(OIDC_CLIENT_REPOSITORY)
        private readonly clients: OidcClientRepository,
        @Inject(SIGN_IN_PRESENTATION)
        private readonly presentations: Pick<
            SignInPresentation,
            "unusableReason"
        >,
        private readonly auditLog: AuditLogService,
        @Inject(OIDC_PROVIDER_SETTINGS)
        private readonly settings: Pick<OidcProviderSettings, "subjectKey">,
    ) {}

    list(tenantId: string): Promise<OidcClient[]> {
        return this.clients.listForTenant(tenantId);
    }

    async get(tenantId: string, id: string): Promise<OidcClient> {
        const client = await this.clients.findForTenant(tenantId, id);
        if (!client) throw new OidcClientNotFound(id);
        return client;
    }

    async create(
        tenantId: string,
        input: CreateOidcClient,
        actor?: OidcClientActor,
    ): Promise<{ client: OidcClient; clientSecret: string }> {
        this.assertRedirectUris(input.redirectUris);
        await this.assertScopes(tenantId, input.scopes, input.subject);
        const clientSecret = generateClientSecret();
        const client = await this.clients.save({
            id: v4(),
            tenantId,
            name: input.name,
            redirectUris: input.redirectUris,
            profile: input.profile,
            scopes: input.scopes,
            secrets: [newSecret(clientSecret)],
            subject: input.subject ?? null,
            claimsFrom: input.claimsFrom ?? null,
        });
        await this.record(tenantId, "oidc_client_created", actor, {
            after: forLog(client),
        });
        return { client, clientSecret };
    }

    async update(
        tenantId: string,
        id: string,
        input: UpdateOidcClient,
        actor?: OidcClientActor,
    ): Promise<OidcClient> {
        const existing = await this.get(tenantId, id);
        if (input.redirectUris) this.assertRedirectUris(input.redirectUris);
        const subject =
            input.subject === undefined ? existing.subject : input.subject;
        if (input.scopes || input.subject) {
            await this.assertScopes(
                tenantId,
                input.scopes ?? existing.scopes,
                subject,
            );
        }
        const saved = await this.clients.save({
            ...existing,
            name: input.name ?? existing.name,
            redirectUris: input.redirectUris ?? existing.redirectUris,
            profile: input.profile ?? existing.profile,
            scopes: input.scopes ?? existing.scopes,
            subject,
            claimsFrom:
                input.claimsFrom === undefined
                    ? existing.claimsFrom
                    : input.claimsFrom,
        });
        await this.record(tenantId, "oidc_client_updated", actor, {
            before: forLog(existing),
            after: forLog(saved),
        });
        return saved;
    }

    async delete(
        tenantId: string,
        id: string,
        actor?: OidcClientActor,
    ): Promise<void> {
        const existing = await this.get(tenantId, id);
        await this.clients.deleteForTenant(tenantId, id);
        await this.record(tenantId, "oidc_client_deleted", actor, {
            before: forLog(existing),
        });
    }

    async addSecret(
        tenantId: string,
        id: string,
        actor?: OidcClientActor,
    ): Promise<{ secret: OidcClientSecret; clientSecret: string }> {
        const existing = await this.get(tenantId, id);
        if (existing.secrets.length >= MAX_CLIENT_SECRETS) {
            throw new OidcClientSecretConflict(
                `A client has at most ${MAX_CLIENT_SECRETS} secrets; delete one first`,
            );
        }
        const clientSecret = generateClientSecret();
        const secret = newSecret(clientSecret);
        const saved = await this.clients.save({
            ...existing,
            secrets: [...existing.secrets, secret],
        });
        await this.record(tenantId, "oidc_client_secret_added", actor, {
            before: forLog(existing),
            after: forLog(saved),
        });
        return { secret, clientSecret };
    }

    async updateSecret(
        tenantId: string,
        id: string,
        secretId: string,
        input: UpdateOidcClientSecret,
        actor?: OidcClientActor,
    ): Promise<OidcClientSecret> {
        const existing = await this.get(tenantId, id);
        const secret = existing.secrets.find((entry) => entry.id === secretId);
        if (!secret) throw new OidcClientSecretNotFound(secretId);
        const updated: OidcClientSecret = {
            ...secret,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        };
        const saved = await this.clients.save({
            ...existing,
            secrets: existing.secrets.map((entry) =>
                entry.id === secretId ? updated : entry,
            ),
        });
        await this.record(tenantId, "oidc_client_secret_updated", actor, {
            before: forLog(existing),
            after: forLog(saved),
        });
        return updated;
    }

    async deleteSecret(
        tenantId: string,
        id: string,
        secretId: string,
        actor?: OidcClientActor,
    ): Promise<void> {
        const existing = await this.get(tenantId, id);
        if (!existing.secrets.some((entry) => entry.id === secretId)) {
            throw new OidcClientSecretNotFound(secretId);
        }
        if (existing.secrets.length <= 1) {
            throw new OidcClientSecretConflict(
                "A client's last secret cannot be deleted; add a new one first",
            );
        }
        const saved = await this.clients.save({
            ...existing,
            secrets: existing.secrets.filter((entry) => entry.id !== secretId),
        });
        await this.record(tenantId, "oidc_client_secret_deleted", actor, {
            before: forLog(existing),
            after: forLog(saved),
        });
    }

    private assertRedirectUris(uris: string[]): void {
        for (const uri of uris) {
            const problem = redirectUriProblem(uri);
            if (problem) throw new InvalidOidcClient(problem);
        }
    }

    private async assertScopes(
        tenantId: string,
        scopes: OidcClientScope[],
        subject: SubjectClaim | null | undefined,
    ): Promise<void> {
        const problem = scopesProblem(scopes);
        if (problem) throw new InvalidOidcClient(problem);
        if (subject && !this.settings.subjectKey) {
            throw new InvalidOidcClient(
                "subject needs MASTER_SECRET, from which the key of the pairwise subjects is derived",
            );
        }
        for (const { presentationConfigId } of scopes) {
            const unusable = await this.presentations.unusableReason(
                tenantId,
                presentationConfigId,
                subject?.credentialId,
            );
            if (unusable) throw new InvalidOidcClient(unusable);
        }
    }

    private async record(
        tenantId: string,
        actionType: AuditActionType,
        actor: OidcClientActor | undefined,
        change: {
            before?: Record<string, unknown>;
            after?: Record<string, unknown>;
        },
    ): Promise<void> {
        if (!actor) return;
        await this.auditLog.record({
            tenantId,
            actionType,
            actor: resolveAuditActor(actor.token),
            changedFields: getChangedFields(change.before, change.after),
            before: change.before,
            after: change.after,
            requestMeta: actor.requestMeta,
        });
    }
}

function newSecret(clientSecret: string): OidcClientSecret {
    return {
        id: v4(),
        hash: hashClientSecret(clientSecret),
        createdAt: new Date(),
        expiresAt: null,
        lastUsedAt: null,
    };
}

/** A client for the audit log: secret metadata, never a hash. */
function forLog(client: OidcClient): Record<string, unknown> {
    return {
        id: client.id,
        name: client.name,
        redirectUris: client.redirectUris,
        profile: client.profile,
        scopes: client.scopes,
        subject: client.subject ?? null,
        claimsFrom: client.claimsFrom ?? null,
        secrets: client.secrets.map((secret) => ({
            id: secret.id,
            expiresAt: secret.expiresAt?.toISOString() ?? null,
        })),
    };
}
