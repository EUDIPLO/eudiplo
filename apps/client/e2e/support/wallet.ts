// A headless wallet for specs that need a wallet to accept an offer or answer
// a presentation request, like the phone in the cookbooks. It supports what the
// cookbooks use: pre-authorized SD-JWT VC offers with a JWT proof, and signed
// OpenID4VP requests answered by direct_post.jwt.
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import {
  type CallbackContext,
  clientAuthenticationAnonymous,
  type Jwk,
  type JwtSignerJwk,
  setGlobalConfig,
} from '@openid4vc/oauth2';
import { Openid4vciClient } from '@openid4vc/openid4vci';
import { Openid4vpClient } from '@openid4vc/openid4vp';
import { SDJwtVcInstance } from '@sd-jwt/sd-jwt-vc';
import {
  type CryptoKey,
  EncryptJWT,
  exportJWK,
  generateKeyPair,
  importJWK,
  importX509,
  type JWK,
  jwtVerify,
  SignJWT,
} from 'jose';

// The E2E backend's PUBLIC_URL is plain HTTP on localhost.
setGlobalConfig({ allowInsecureUrls: true });

export interface HolderCredential {
  /** The issued SD-JWT VC in compact form. */
  credential: string;
  /** The disclosed claims of the credential. */
  claims: Record<string, unknown>;
  holderPrivateKey: CryptoKey;
}

const sha256 = (data: string | ArrayBuffer | Uint8Array) =>
  createHash('sha256')
    .update(typeof data === 'string' ? data : new Uint8Array(data))
    .digest();

const unsupported = (): never => {
  throw new Error('Not supported by the E2E wallet');
};

const callbacks: Omit<CallbackContext, 'signJwt'> = {
  hash: (data, alg) => createHash(alg.replace('-', '').toLowerCase()).update(data).digest(),
  generateRandom: (bytes) => randomBytes(bytes),
  verifyJwt: async (signer, { compact }) => {
    let key: CryptoKey;
    let signerJwk: Jwk;
    if (signer.method === 'jwk') {
      signerJwk = signer.publicJwk;
      key = (await importJWK(signer.publicJwk as JWK, signer.alg)) as CryptoKey;
    } else if (signer.method === 'x5c') {
      const pem = `-----BEGIN CERTIFICATE-----\n${signer.x5c[0]}\n-----END CERTIFICATE-----`;
      key = await importX509(pem, signer.alg);
      signerJwk = (await exportJWK(key)) as Jwk;
    } else {
      return { verified: false };
    }
    try {
      await jwtVerify(compact, key);
      return { verified: true, signerJwk };
    } catch {
      return { verified: false };
    }
  },
  getX509CertificateMetadata: (certificate) => {
    const altNames = new X509Certificate(Buffer.from(certificate, 'base64')).subjectAltName ?? '';
    const names = altNames.split(',').map((name) => name.trim());
    return {
      sanDnsNames: names.filter((n) => n.startsWith('DNS:')).map((n) => n.slice(4)),
      sanUriNames: names.filter((n) => n.startsWith('URI:')).map((n) => n.slice(4)),
    };
  },
  clientAuthentication: clientAuthenticationAnonymous(),
  encryptJwe: unsupported,
  decryptJwe: unsupported,
};

/**
 * Accepts a pre-authorized credential offer as a wallet would after scanning
 * its QR code, and confirms the credential through the notification endpoint.
 */
export async function acceptCredentialOffer(offerUri: string): Promise<HolderCredential> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const signer: JwtSignerJwk = {
    method: 'jwk',
    alg: 'ES256',
    publicJwk: (await exportJWK(publicKey)) as Jwk,
  };
  const client = new Openid4vciClient({
    callbacks: {
      ...callbacks,
      signJwt: async (jwtSigner, { header, payload }) => ({
        jwt: await new SignJWT(payload).setProtectedHeader(header).sign(privateKey),
        signerJwk: (jwtSigner as JwtSignerJwk).publicJwk,
      }),
    },
  });

  const credentialOffer = await client.resolveCredentialOffer(offerUri);
  const issuerMetadata = await client.resolveIssuerMetadata(credentialOffer.credential_issuer);
  const credentialConfigurationId = credentialOffer.credential_configuration_ids[0];
  const usesDpop = issuerMetadata.authorizationServers.some((server) =>
    server.dpop_signing_alg_values_supported?.includes('ES256')
  );

  const token = await client.retrievePreAuthorizedCodeAccessTokenFromOffer({
    credentialOffer,
    issuerMetadata,
    dpop: usesDpop ? { signer } : undefined,
  });
  const accessToken = token.accessTokenResponse.access_token;
  const { c_nonce } = await client.requestNonce({ issuerMetadata });
  const { jwt } = await client.createCredentialRequestJwtProof({
    issuerMetadata,
    signer,
    issuedAt: new Date(),
    credentialConfigurationId,
    nonce: c_nonce,
  });
  const { credentialResponse, dpop } = await client.retrieveCredentials({
    issuerMetadata,
    accessToken,
    credentialConfigurationId,
    proofs: { jwt: [jwt] },
    dpop: token.dpop,
  });
  const [entry] = credentialResponse.credentials ?? [];
  const credential = typeof entry === 'object' && 'credential' in entry ? entry.credential : entry;
  if (typeof credential !== 'string') {
    throw new Error(`Expected one SD-JWT VC, got ${JSON.stringify(credentialResponse)}`);
  }

  if (credentialResponse.notification_id && issuerMetadata.credentialIssuer.notification_endpoint) {
    await client.sendNotification({
      issuerMetadata,
      accessToken,
      // The credential response only returns a DPoP nonce, if the issuer sent a new one.
      dpop: token.dpop && { ...token.dpop, ...dpop },
      notification: {
        notificationId: credentialResponse.notification_id,
        event: 'credential_accepted',
      },
    });
  }

  const claims = await new SDJwtVcInstance({ hasher: sha256 }).getClaims(credential);
  return { credential, claims, holderPrivateKey: privateKey };
}

/**
 * Answers a presentation request with every claim its DCQL query asks for,
 * from a credential issued by {@link acceptCredentialOffer}.
 */
export async function presentCredential(
  requestUri: string,
  holder: HolderCredential
): Promise<Response> {
  const client = new Openid4vpClient({ callbacks: { ...callbacks, signJwt: unsupported } });
  const parsed = client.parseOpenid4vpAuthorizationRequest({ authorizationRequest: requestUri });
  const { authorizationRequestPayload: request } =
    await client.resolveOpenId4vpAuthorizationRequest({
      authorizationRequestPayload: parsed.params,
      responseMode: { type: 'direct_post' },
    });

  const query = request.dcql_query as {
    credentials: { id: string; claims?: { path: string[] }[] }[];
  };
  const [credentialQuery] = query.credentials;
  // Top-level claims only, as in the cookbooks.
  const frame = Object.fromEntries(
    (credentialQuery.claims ?? []).map((claim) => [claim.path[0], true])
  );
  const sdjwt = new SDJwtVcInstance({
    hasher: sha256,
    kbSignAlg: 'ES256',
    kbSigner: async (data) =>
      Buffer.from(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          holder.holderPrivateKey,
          new TextEncoder().encode(data)
        )
      ).toString('base64url'),
  });
  const presentation = await sdjwt.present(holder.credential, frame, {
    kb: {
      payload: {
        iat: Math.floor(Date.now() / 1000),
        aud: request.client_id as string,
        nonce: request.nonce,
      },
    },
  });

  // EUDIPLO answers QR requests by direct_post.jwt: the response is encrypted
  // to the verifier key in client_metadata.
  if (request.response_mode !== 'direct_post.jwt') {
    throw new Error(`Unsupported response_mode ${request.response_mode}`);
  }
  const metadata = request.client_metadata as {
    jwks: { keys: JWK[] };
    encrypted_response_enc_values_supported?: string[];
  };
  const verifierKey = metadata.jwks.keys[0];
  const response = await new EncryptJWT({
    vp_token: { [credentialQuery.id]: [presentation] },
    state: request.state,
  })
    .setProtectedHeader({
      alg: 'ECDH-ES',
      enc: metadata.encrypted_response_enc_values_supported?.[0] ?? 'A128GCM',
      ...(verifierKey.kid && { kid: verifierKey.kid }),
    })
    .encrypt(await importJWK(verifierKey, 'ECDH-ES'));

  return fetch(request.response_uri as string, {
    method: 'POST',
    body: new URLSearchParams({ response }),
  });
}
