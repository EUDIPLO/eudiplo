import { Injectable } from "@nestjs/common";
import type {
    CredentialIssuanceContext,
    CredentialIssuerFormat,
} from "../domain/credential-issuer-format.js";
import { CredentialFormat } from "../entities/credential.entity.js";
import { MdocIssuerService } from "../issuer/mdoc-issuer/mdoc-issuer.service.js";

@Injectable()
export class MdocCredentialIssuerFormat implements CredentialIssuerFormat {
    readonly format = CredentialFormat.MSO_MDOC;

    constructor(private readonly issuer: MdocIssuerService) {}

    issue(context: CredentialIssuanceContext): Promise<string> {
        return this.issuer.issue({
            credentialConfiguration: context.credentialConfiguration,
            deviceKey: context.holderKey,
            session: context.session,
            claims: context.claims,
            issuanceSetId: context.issuanceSetId,
        });
    }
}
