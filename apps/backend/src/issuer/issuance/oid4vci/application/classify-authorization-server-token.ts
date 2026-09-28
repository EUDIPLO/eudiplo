export type AuthorizationServerTokenKind = "local" | "chained" | "external";

export interface ClassifyAuthorizationServerTokenInput {
    tokenIssuer: string;
    localIssuer: string;
    chainedIssuer: string;
    hasChainedAuthorizationServer: boolean;
    managedAuthorizationServerIssuers: ReadonlySet<string>;
}

export class ClassifyAuthorizationServerToken {
    execute(
        input: ClassifyAuthorizationServerTokenInput,
    ): AuthorizationServerTokenKind {
        if (input.tokenIssuer === input.localIssuer) return "local";
        if (
            (input.hasChainedAuthorizationServer &&
                input.tokenIssuer === input.chainedIssuer) ||
            input.managedAuthorizationServerIssuers.has(input.tokenIssuer)
        ) {
            return "chained";
        }
        return "external";
    }
}
