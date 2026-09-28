import type { LoTE } from "@owf/eudi-lote";
import { decodeJwt } from "jose";
import type { LoteParserService } from "../lote-parser.service.js";
import type { TrustListProvider } from "../ports/trust-list-provider.js";
import type { TrustListJwtService } from "../trustlist-jwt.service.js";
import type { TrustListRef } from "../types.js";

export class VerifiedLoteProvider implements TrustListProvider {
    constructor(
        private readonly jwt: Pick<
            TrustListJwtService,
            "fetchJwt" | "verifyTrustListJwt"
        >,
        private readonly parser: Pick<LoteParserService, "parse">,
    ) {}
    async loadVerified(reference: TrustListRef) {
        const token = await this.jwt.fetchJwt(reference.url);
        await this.jwt.verifyTrustListJwt(reference, token);
        const parsed = this.parser.parse(decodeJwt<{ LoTE: LoTE }>(token).LoTE);
        return {
            nextUpdate: parsed.info.nextUpdate,
            entities: parsed.entities,
        };
    }
}
