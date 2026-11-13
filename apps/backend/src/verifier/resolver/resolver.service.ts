import { X509Certificate } from "node:crypto";
import { ConflictException, Injectable } from "@nestjs/common";
import { JWK } from "jose";

/**
 * Service for resolving public keys from JWT payloads and headers.
 */
@Injectable()
export class ResolverService {
    /**
     * Resolve the public key from the issuer, x5c header only supported.
     * @param payload
     * @param header
     * @returns The key of the first certificate of `x5c`; the others are
     * read by the chain check (`CredentialChainValidationService`)
     */
    resolvePublicKey(header: JWK): Promise<JWK> {
        //we ignore is iss value since it is no required when using x5c: https://www.ietf.org/archive/id/draft-ietf-oauth-sd-jwt-vc-13.html#name-registered-jwt-claims
        if (header.x5c) {
            // The chain check of CredentialChainValidationService reads the
            // rest of x5c, and limits its length, where a trust list applies.
            const cert = new X509Certificate(
                Buffer.from(header.x5c[0], "base64"),
            );
            return Promise.resolve(
                cert.publicKey.export({ format: "jwk" }) as JWK,
            );
        } else {
            throw new ConflictException("No x5c header found in the JWT");
        }
    }
}
