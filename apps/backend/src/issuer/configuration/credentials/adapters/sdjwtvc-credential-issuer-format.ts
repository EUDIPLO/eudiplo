import { Injectable } from "@nestjs/common";
import type {
    CredentialIssuanceContext,
    CredentialIssuerFormat,
} from "../domain/credential-issuer-format.js";
import { CredentialFormat } from "../entities/credential.entity.js";
import { SdjwtvcIssuerService } from "../issuer/sdjwtvc-issuer/sdjwtvc-issuer.service.js";

@Injectable()
export class SdjwtvcCredentialIssuerFormat implements CredentialIssuerFormat {
    readonly format = CredentialFormat.SD_JWT_VC;

    constructor(private readonly issuer: SdjwtvcIssuerService) {}

    issue(context: CredentialIssuanceContext): Promise<string> {
        return this.issuer.issue({
            credentialConfiguration: context.credentialConfiguration,
            holderCnf: context.holderKey,
            session: context.session,
            claims: context.claims,
            federationEntityId: context.federationEntityId,
            issuanceSetId: context.issuanceSetId,
        });
    }
}
