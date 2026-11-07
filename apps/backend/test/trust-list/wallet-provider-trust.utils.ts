import type { INestApplication } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { X509Certificate } from "@peculiar/x509";
import type { Repository } from "typeorm";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import type { BuiltInAuthorizationServerConfig } from "../../src/issuer/configuration/issuance/dto/authorization-server-config.dto.js";
import type { IssuanceDto } from "../../src/issuer/configuration/issuance/dto/issuance.dto.js";
import { IssuanceService } from "../../src/issuer/configuration/issuance/issuance.service.js";
import type { TrustListCreateDto } from "../../src/issuer/trust-list/dto/trust-list-create.dto.js";
import { TrustListService } from "../../src/issuer/trust-list/trustlist.service.js";
import { TrustStoreService } from "../../src/trust/trust-store.service.js";

/** Publish fresh OIDF attester roots through EUDIPLO's real trust-list endpoint. */
export async function configureWalletProviderTrust(
    app: INestApplication,
    tenantId: string,
    internalUrl: string,
    issuanceConfig: Partial<IssuanceDto>,
    attesterRoots: { name: string; certificate: string }[],
) {
    const tenants = app.get<Repository<TenantEntity>>(
        getRepositoryToken(TenantEntity),
    );
    const tenant = await tenants.findOneByOrFail({ id: tenantId });
    const trustLists = app.get(TrustListService);
    const id = "oidf-wallet-providers";
    const config: TrustListCreateDto = {
        id,
        description: "OIDF test wallet and key attestation providers",
        entities: attesterRoots.map(({ name, certificate }) => {
            const pem = new X509Certificate(certificate).toString("pem");
            return {
                type: "external",
                providerType: "wallet-provider",
                issuerCertPem: pem,
                // The test provider uses the same CA for issuance and status.
                revocationCertPem: pem,
                info: { name, lang: "en" },
            };
        }),
    };
    const existing = (await trustLists.findAll(tenant)).find(
        (list) => list.id === id,
    );
    if (existing) {
        await trustLists.update(tenantId, id, config);
    } else {
        await trustLists.create(config, tenant);
    }
    const walletProviderTrustLists = [
        {
            url: `${internalUrl.replace(/\/$/, "")}/issuers/${tenantId}/trust-list/${id}`,
            verifierX509Der: await trustLists.getVerifierX509Der(tenantId, id),
        },
    ];
    // Refresh even when fixture import uses 'create' and skips existing configs.
    await app.get(IssuanceService).storeIssuanceConfiguration(tenantId, {
        ...issuanceConfig,
        walletProviderTrustLists,
        authorizationServers: issuanceConfig.authorizationServers?.map(
            (server) => {
                if (server.type !== "built-in") return server;
                const { walletProviderTrustLists: _override, ...builtIn } =
                    server as BuiltInAuthorizationServerConfig;
                return { ...builtIn, walletAttestationRequired: true };
            },
        ),
    });
    app.get(TrustStoreService).clearCache();
    // Fail setup immediately if the real endpoint or signature cannot be verified.
    await app
        .get(TrustStoreService)
        .getTrustStore({ tenantId, lotes: walletProviderTrustLists });
    return walletProviderTrustLists;
}
