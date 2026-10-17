export const FEDERATION_RESOLVER_SETTINGS = Symbol(
    "FEDERATION_RESOLVER_SETTINGS",
);

/** How OpenID Federation trust chains are resolved (`FEDERATION_RESOLVER`). */
export type FederationResolverSettings =
    | {
          type: "local";
          /** Allowed clock difference for `iat` and `exp` (`CRYPTO_TOLERANCE`). */
          clockToleranceSeconds: number;
      }
    | { type: "http"; url: string; token?: string };
