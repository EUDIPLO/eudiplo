import { HttpModule } from "@nestjs/axios";
import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module.js";
import { RegistrarModule } from "../registrar/registrar.module.js";
import { SessionModule } from "../session/session.module.js";
import { Iso18013Module } from "./iso18013/iso18013.module.js";
import { Oid4vpModule } from "./oid4vp/oid4vp.module.js";
import { OidcProviderModule } from "./oidc-provider/oidc-provider.module.js";
import { PresentationsModule } from "./presentations/presentations.module.js";
import { VerifierOfferController } from "./verifier-offer/verifier-offer.controller.js";

@Module({
    imports: [
        CryptoModule,
        RegistrarModule,
        SessionModule,
        HttpModule,
        PresentationsModule,
        Oid4vpModule,
        Iso18013Module,
        OidcProviderModule,
    ],
    controllers: [VerifierOfferController],
})
export class VerifierModule {}
