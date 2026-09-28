import type { UpdateSessionForTenant } from "../../../session/application/update-session-for-tenant.js";
import { SessionStatus } from "../../../session/domain/session-state.js";

export interface CompletePresentationResponseInput {
    tenantId: string;
    sessionId: string;
    credentials: unknown[];
    responseCode: string;
    consumedAt?: Date;
}

export class CompletePresentationResponse {
    constructor(
        private readonly updateSession: Pick<UpdateSessionForTenant, "execute">,
    ) {}

    async execute(input: CompletePresentationResponseInput): Promise<void> {
        await this.updateSession.execute(input.tenantId, input.sessionId, {
            credentials: input.credentials as any,
            status: SessionStatus.Completed,
            responseCode: input.responseCode,
            consumed: true,
            consumedAt: input.consumedAt ?? new Date(),
            responseEncryptionPrivateJwk: null,
            outcome: {
                result: "success",
                credentials: input.credentials.map((credential: any) => ({
                    id:
                        typeof credential?.id === "string"
                            ? credential.id
                            : undefined,
                    verified: true,
                })),
            },
        });
    }
}
