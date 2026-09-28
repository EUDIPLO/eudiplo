import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";
import type {
    OidcDiscoveryDocument,
    OidcDiscoveryResolver,
} from "../ports/oidc-discovery-resolver.js";

export class HttpOidcDiscoveryResolver implements OidcDiscoveryResolver {
    constructor(private readonly http: HttpService) {}

    async resolve(issuer: string): Promise<OidcDiscoveryDocument> {
        const wellKnownUrl = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
        const response = await firstValueFrom(
            this.http.get<OidcDiscoveryDocument>(wellKnownUrl),
        );
        return response.data;
    }
}
