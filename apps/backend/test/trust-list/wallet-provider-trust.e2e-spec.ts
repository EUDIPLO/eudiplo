import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { decodeJwt, importJWK, SignJWT } from "jose";
import type { Repository } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { KeyChainImportService } from "../../src/crypto/key/key-chain-import.service.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import type { BuiltInAuthorizationServerConfig } from "../../src/issuer/configuration/issuance/dto/authorization-server-config.dto.js";
import { IssuanceService } from "../../src/issuer/configuration/issuance/issuance.service.js";
import { validateAttestationProofTrust } from "../../src/issuer/issuance/oid4vci/attestation-proof-trust.util.js";
import { resolveWalletAttestationPolicy } from "../../src/issuer/issuance/oid4vci/authorization/domain/wallet-attestation-policy.js";
import { TrustListService } from "../../src/issuer/trust-list/trustlist.service.js";
import { TrustStoreService } from "../../src/trust/trust-store.service.js";
import { walletSolutionServiceTypes } from "../../src/trust/types.js";
import { X509ValidationService } from "../../src/trust/x509-validation.service.js";
import { generateCaSignedJwk } from "../oidf/utils.js";
import { configureWalletProviderTrust } from "./wallet-provider-trust.utils.js";

describe("Hosted wallet provider trust", () => {
    let app: INestApplication;
    let url: string;
    let folder: string;
    const tenantId = "wallet-trust-test";
    const issuance = {
        authorizationServers: [
            { id: "issuer-built-in", type: "built-in" as const },
        ],
    };
    let wallet: Awaited<ReturnType<typeof generateCaSignedJwk>>;
    let keyAttester: typeof wallet;
    let refs: Awaited<ReturnType<typeof configureWalletProviderTrust>>;

    const publish = (attesters: (typeof wallet)[]) =>
        configureWalletProviderTrust(
            app,
            tenantId,
            url,
            issuance,
            attesters.map((attester, index) => ({
                name: `Test provider ${index}`,
                certificate: attester.x5c.at(-1)!,
            })),
        );
    const validate = async (attester: typeof wallet) => {
        const jwt = await new SignJWT({})
            .setProtectedHeader({ alg: "ES256", x5c: attester.x5c })
            .sign(await importJWK(attester, "ES256"));
        return validateAttestationProofTrust(jwt, refs, {
            trustStoreService: app.get(TrustStoreService),
            x509ValidationService: app.get(X509ValidationService),
        });
    };

    beforeAll(async () => {
        folder = mkdtempSync(join(tmpdir(), "eudiplo-wallet-trust-"));
        const previousFolder = process.env.FOLDER;
        process.env.FOLDER = folder;
        try {
            const module = await Test.createTestingModule({
                imports: [AppModule],
            }).compile();
            app = module.createNestApplication();
            app.get(ConfigService).set("CONFIG_IMPORT_MODE", "disabled");
            await app.init();
            await app.listen(0, "127.0.0.1");
            url = await app.getUrl();
        } finally {
            if (previousFolder === undefined) delete process.env.FOLDER;
            else process.env.FOLDER = previousFolder;
        }
        await app
            .get<Repository<TenantEntity>>(getRepositoryToken(TenantEntity))
            .save({ id: tenantId, name: "Test wallet providers" });
        wallet = await generateCaSignedJwk({
            use: "sig",
            alg: "ES256",
            cn: "Wallet attester",
        });
        keyAttester = await generateCaSignedJwk({
            use: "sig",
            alg: "ES256",
            cn: "Key attester",
        });
        const signer = await generateCaSignedJwk({
            use: "sig",
            alg: "ES256",
            cn: "Trust list signer",
        });
        await app.get(KeyChainImportService).importKeyChain(tenantId, {
            id: "test-list-signer",
            usageType: KeyUsageType.TrustList,
            key: signer,
            crt: signer.x5c,
        });
        refs = await publish([wallet, keyAttester]);
        expect(refs[0].verifierX509Der).toBe(signer.x5c[0]);
    }, 30000);

    afterAll(async () => {
        await app?.close();
        if (folder) rmSync(folder, { recursive: true, force: true });
    });

    test("serves a signed wallet list and shares its trust with the required AS policy", async () => {
        const response = await fetch(refs[0].url);
        expect(response.ok).toBe(true);
        const payload = decodeJwt(await response.text()) as any;
        expect(payload.LoTE.ListAndSchemeInformation.LoTEType).toBe(
            "http://uri.etsi.org/19602/LoTEType/EUWalletProvidersList",
        );
        const store = await app.get(TrustStoreService).getTrustStore({
            lotes: refs,
            acceptedServiceTypes: [...walletSolutionServiceTypes],
        });
        expect(store.entities).toHaveLength(2);
        const config = await app
            .get(IssuanceService)
            .getIssuanceConfiguration(tenantId);
        expect(
            resolveWalletAttestationPolicy(
                config,
                config.authorizationServers![0] as BuiltInAuthorizationServerConfig,
            ),
        ).toEqual({
            walletAttestationRequired: true,
            walletProviderTrustLists: refs,
        });
        await expect(validate(wallet)).resolves.toBeUndefined();
        await expect(validate(keyAttester)).resolves.toBeUndefined();
    });

    test("rejects an untrusted attester and a wrong trust-list verifier", async () => {
        const untrusted = await generateCaSignedJwk({
            use: "sig",
            alg: "ES256",
            cn: "Untrusted",
        });
        await expect(validate(untrusted)).rejects.toThrow();
        await expect(
            app.get(TrustStoreService).getTrustStore({
                lotes: [{ ...refs[0], verifierX509Der: untrusted.x5c[0] }],
            }),
        ).rejects.toThrow("verification failed");
    });

    test("refreshes the hosted list on another run and stops trusting old roots", async () => {
        const nextWallet = await generateCaSignedJwk({
            use: "sig",
            alg: "ES256",
            cn: "Next wallet",
        });
        refs = await publish([nextWallet, keyAttester]);
        await expect(validate(nextWallet)).resolves.toBeUndefined();
        await expect(validate(wallet)).rejects.toThrow();
        const list = await app
            .get(TrustListService)
            .findOne(tenantId, "oidf-wallet-providers");
        expect(list.sequenceNumber).toBe(2);
        expect(
            list.entityConfig?.every(
                (entity) => entity.providerType === "wallet-provider",
            ),
        ).toBe(true);
    });
    test("signs with the selected key chain when the tenant has multiple list signers", async () => {
        const signer = await generateCaSignedJwk({
            use: "sig",
            alg: "ES256",
            cn: "Selected signer",
        });
        const keyChainId = await app
            .get(KeyChainImportService)
            .importKeyChain(tenantId, {
                id: "selected-list-signer",
                usageType: KeyUsageType.TrustList,
                key: signer,
                crt: signer.x5c,
            });
        const lists = app.get(TrustListService);
        const config = await lists.exportTrustList(
            tenantId,
            "oidf-wallet-providers",
        );
        await lists.update(tenantId, config.id!, { ...config, keyChainId });
        const verifierX509Der = await lists.getVerifierX509Der(
            tenantId,
            config.id!,
        );
        expect(verifierX509Der).toBe(signer.x5c[0]);
        await expect(
            app.get(TrustStoreService).getTrustStore({
                lotes: [{ ...refs[0], verifierX509Der }],
            }),
        ).resolves.toMatchObject({ entities: expect.any(Array) });
    });

    test("keeps credential-provider service types when providerType is omitted", async () => {
        const lists = app.get(TrustListService);
        const config = await lists.exportTrustList(
            tenantId,
            "oidf-wallet-providers",
        );
        const list = await lists.update(tenantId, config.id!, {
            ...config,
            entities: config.entities.map(
                ({ providerType: _type, ...entity }) => entity,
            ),
        });
        const payload = decodeJwt(list.jwt) as any;
        expect(payload.LoTE.ListAndSchemeInformation.LoTEType).toBe(
            "http://uri.etsi.org/19602/LoTEType/EUEAAProvidersList",
        );
        const services =
            payload.LoTE.TrustedEntitiesList[0].TrustedEntityServices;
        expect(
            services.map(
                (service: any) =>
                    service.ServiceInformation.ServiceTypeIdentifier,
            ),
        ).toEqual([
            "http://uri.etsi.org/19602/SvcType/EAA/Issuance",
            "http://uri.etsi.org/19602/SvcType/EAA/Revocation",
        ]);
    });
});
