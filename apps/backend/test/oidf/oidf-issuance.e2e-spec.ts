import { readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { join, resolve } from "node:path";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestExpressApplication } from "@nestjs/platform-express";
import { Test, TestingModule } from "@nestjs/testing";
import * as x509 from "@peculiar/x509";
import * as axios from "axios";
import { Logger } from "nestjs-pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import {
    FlowType,
    OfferRequestDto,
    OfferResponse,
} from "../../src/issuer/issuance/oid4vci/dto/offer-request.dto.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { getDefaultSecret, readConfig } from "../utils.js";
import {
    BACKEND_TEST_CA_PATH,
    OIDF_HTTPD_CA_PATH,
    shouldExportOidfLogs,
    useOidfContainers,
} from "./oidf-setup.js";
import { OIDFSuite, TestInstance } from "./oidf-suite.js";
import { generateCaSignedJwk } from "./utils.js";

// Set up the x509 crypto provider
x509.cryptoProvider.set(globalThis.crypto);

// Setup OIDF containers for this test file
useOidfContainers();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Disable TLS verification for testing purposes

// Static list of issuer HAIP modules. Loaded synchronously at collection time
// so vitest can register one `it()` per (variant, module). The list is
// validated against the live OIDF plan in `beforeAll` and auto-rewritten if it
// drifts; the test then fails with a clear "re-run" message.
const SNAPSHOT_PATH = resolve(__dirname, "oidf-issuer-modules.snapshot.json");
const ISSUER_HAIP_MODULES: readonly string[] = (() => {
    try {
        const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8"));
        return Array.isArray(raw)
            ? (raw.filter((v) => typeof v === "string") as string[])
            : [];
    } catch {
        return [];
    }
})();

const FAPI2_SECURITY_PROFILE_FINAL_PREFIX = "fapi2-security-profile-final";
// Module -> reason. Keep reasons specific so skipped coverage stays visible in reports.
const EXPLICITLY_SKIPPED_ISSUER_MODULES = new Map<string, string>([
    // The built-in AS has no end-user login/consent step.
    [
        "fapi2-security-profile-final-user-rejects-authentication",
        "requires interactive user rejection",
    ],
    [
        "fapi2-security-profile-final-par-ensure-reused-request-uri-prior-to-auth-completion-succeeds",
        "requires an interactive login page",
    ],
    // Passing requires redirecting errors to an unregistered redirect_uri (open redirect).
    [
        "fapi2-security-profile-final-ensure-unsigned-authorization-request-without-using-par-fails",
        "error page needs manual screenshot upload",
    ],
]);
// The suite redeems the same issuer_state with a second client; offers are single-use by design.
const ISSUER_INITIATED_SKIPPED_MODULES = new Map<string, string>([
    [
        "oid4vci-1_0-issuer-happy-flow-multiple-clients",
        "second client reuses a single-use credential offer",
    ],
]);

const normalizeCertEntryToPem = (certEntry: string): string => {
    const trimmed = certEntry.trim();
    if (
        trimmed.includes("-----BEGIN CERTIFICATE-----") &&
        trimmed.includes("-----END CERTIFICATE-----")
    ) {
        return trimmed;
    }

    const normalized = trimmed.replace(/\s+/g, "");
    const der = Buffer.from(normalized, "base64");
    if (der.length === 0) {
        throw new Error("Certificate entry decoded to empty DER");
    }

    const body =
        der
            .toString("base64")
            .match(/.{1,64}/g)
            ?.join("\n") ?? "";
    return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
};

const getRootTrustAnchorPemFromKeyChain = (
    keyChain: { crt?: string[] },
    keyChainName: string,
): string => {
    if (!Array.isArray(keyChain.crt) || keyChain.crt.length === 0) {
        throw new Error(
            `${keyChainName} key chain does not contain crt entries for trust anchor configuration`,
        );
    }

    // crt is modeled as leaf-first; root CA is the last element.
    return normalizeCertEntryToPem(keyChain.crt.at(-1)!);
};

/**
 * E2E: OIDF conformance runner integration test for HAIP issuer test plan.
 * This test suite covers all tests from the oid4vci-1_0-issuer-haip-test-plan.
 *
 * Tests include:
 * - Metadata validation tests
 * - Happy flow tests (credential issuance)
 * - Error handling tests (invalid signatures, missing proofs, etc.)
 */
describe("OIDF - oid4vci-1_0-issuer-haip-test-plan", () => {
    const PUBLIC_DOMAIN =
        import.meta.env.VITE_DOMAIN ?? "host.testcontainers.internal:3000";
    const OIDF_URL = import.meta.env.VITE_OIDF_URL ?? "https://localhost:8443";
    const OIDF_DEMO_TOKEN = import.meta.env.VITE_OIDF_DEMO_TOKEN;
    const MODULE_FILTERS = (import.meta.env.VITE_OIDF_MODULES ?? "")
        .split(",")
        .map((value: string) => value.trim())
        .filter((value: string) => value.length > 0);
    const MODULE_PATTERN = import.meta.env.VITE_OIDF_MODULE_PATTERN
        ? new RegExp(import.meta.env.VITE_OIDF_MODULE_PATTERN)
        : undefined;

    let app: INestApplication;
    let authToken: string;

    const SD_JWT_VC_CREDENTIAL_CONFIGURATION_ID = "pid";
    const MDOC_CREDENTIAL_CONFIGURATION_ID = "pid-mdoc";

    const ISSUER_VARIANT_MATRIX = [
        {
            credential_format: "sd_jwt_vc",
            vci_authorization_code_flow_variant: "issuer_initiated",
        },
        {
            credential_format: "sd_jwt_vc",
            vci_authorization_code_flow_variant: "wallet_initiated",
        },
        {
            credential_format: "mdoc",
            vci_authorization_code_flow_variant: "issuer_initiated",
        },
        {
            credential_format: "mdoc",
            vci_authorization_code_flow_variant: "wallet_initiated",
        },
    ] as const;

    type IssuerVariant = (typeof ISSUER_VARIANT_MATRIX)[number];

    const getCredentialConfigurationIdForVariant = (
        variant: IssuerVariant,
    ): string =>
        variant.credential_format === "mdoc"
            ? MDOC_CREDENTIAL_CONFIGURATION_ID
            : SD_JWT_VC_CREDENTIAL_CONFIGURATION_ID;

    const createdPlans: Array<{
        planId: string;
        variant: IssuerVariant;
    }> = [];
    const executedPlanIds = new Set<string>();
    const axiosBackendInstance = axios.default.create({
        baseURL: "https://localhost:3000",
        httpsAgent: new https.Agent({
            ca: readFileSync(BACKEND_TEST_CA_PATH),
            checkServerIdentity: () => undefined,
        }),
    });

    const oidfSuite = new OIDFSuite(OIDF_URL, OIDF_DEMO_TOKEN);
    const oidfSuiteStartTest = oidfSuite.startTest.bind(oidfSuite);
    oidfSuite.startTest = async (
        planId: string,
        testName: string,
    ): Promise<TestInstance> => {
        executedPlanIds.add(planId);
        return oidfSuiteStartTest(planId, testName);
    };

    /**
     * Helper function to send a credential offer to the OIDF test runner.
     * Creates an offer via the backend API and forwards it to the test instance endpoint.
     * Uses authorization code flow as required by HAIP.
     */
    async function sendOfferToTestRunner(
        testInstance: TestInstance,
        credentialConfigurationId = SD_JWT_VC_CREDENTIAL_CONFIGURATION_ID,
    ): Promise<void> {
        // Request an issuance offer from the local backend using authorization code flow
        const offerResponse = await axiosBackendInstance
            .post<
                OfferResponse,
                axios.AxiosResponse<OfferResponse, OfferRequestDto>,
                OfferRequestDto
            >(
                "/issuer/offer",
                {
                    response_type: ResponseType.URI,
                    credentialConfigurationIds: [credentialConfigurationId],
                    flow: FlowType.AUTH_CODE,
                },
                {
                    headers: {
                        Authorization: `Bearer ${authToken}`,
                    },
                },
            )
            .catch((err) => {
                console.log(err);
                throw new Error(err);
            });

        expect(offerResponse.data.uri).toBeDefined();

        // Extract parameters from the URI
        const uriParts = offerResponse.data.uri.split("//");
        if (uriParts.length < 2) {
            throw new Error(`Invalid URI format: ${offerResponse.data.uri}`);
        }
        const parameters = uriParts[1];

        // Get the credential offer endpoint from the test runner
        const url = await oidfSuite.getEndpoint(testInstance);
        if (!url.startsWith("https://")) {
            throw new Error(
                `Expected HTTPS credential_offer_endpoint, got: ${url}`,
            );
        }

        // Send the offer to the OIDF test runner
        await axios.default.get(`${url}${parameters}`, {
            httpsAgent: new https.Agent({
                ca: readFileSync(OIDF_HTTPD_CA_PATH),
                checkServerIdentity: () => undefined,
            }),
            proxy: false,
        });
    }

    beforeAll(async () => {
        const planName = "oid4vci-1_0-issuer-haip-test-plan";

        // Generate CA-signed certificates on demand for valid timestamps
        const clientSigningJwk = await generateCaSignedJwk({
            use: "sig",
            alg: "ES256",
            cn: "OIDF Test Client",
        });

        // Test-only attester keys match the CA certificates in the HAIP
        // wallet-providers trust-list fixture. Keep the two fixtures in sync.
        const { wallet: attesterJwk, key: keyAttestationJwk } = JSON.parse(
            readFileSync(
                resolve(__dirname, "fixtures/wallet-attesters.json"),
                "utf8",
            ),
        );

        // Generate encryption key material for encrypted credential delivery
        const encryptionJwk = await generateCaSignedJwk({
            use: "enc",
            alg: "ECDH-ES",
            cn: "OIDF Encryption Key",
        });

        // Generate trust anchor PEMs from the issuer's key chains
        // These are the CA certificates that signed the issuer's credential and status list
        const configFolder = resolve(__dirname + "/../fixtures");
        const attestationKeyChain = readConfig<{ crt?: string[] }>(
            join(configFolder, "haip/key-chains/attestation.json"),
        );
        const statusListKeyChain = readConfig<{ crt?: string[] }>(
            join(configFolder, "haip/key-chains/status-list.json"),
        );

        // Use configured root certificates as trust anchors (do not mint synthetic CAs).
        const trustAnchorPem = getRootTrustAnchorPemFromKeyChain(
            attestationKeyChain,
            "attestation",
        );
        const statusListTrustAnchorPem = getRootTrustAnchorPemFromKeyChain(
            statusListKeyChain,
            "status-list",
        );

        for (const [_index, variant] of ISSUER_VARIANT_MATRIX.entries()) {
            const body = {
                //alias: `eudiplo-${index}`,
                description: `test plan ${variant.credential_format}/${variant.vci_authorization_code_flow_variant}`,
                publish: "everything",
                client: {
                    client_id: "localhost",
                },
                client2: {
                    client_id: "localhost2",
                },
                server: {
                    discoveryIssuer: `https://${PUBLIC_DOMAIN}/issuers/haip`,
                },
                credential: {
                    signing_jwk: clientSigningJwk,
                    trust_anchor_pem: trustAnchorPem,
                    status_list_trust_anchor_pem: statusListTrustAnchorPem,
                    encryption_jwk: encryptionJwk,
                },
                vci: {
                    credential_issuer_url: `https://${PUBLIC_DOMAIN}/issuers/haip`,
                    credential_configuration_id:
                        getCredentialConfigurationIdForVariant(variant),
                    client_attester_keys_jwks: {
                        keys: [attesterJwk],
                    },
                    client_attestation_issuer:
                        "https://client-attester.example.org/",
                    key_attestation_jwks: {
                        keys: [keyAttestationJwk],
                    },
                },
                browser: [
                    {
                        comment:
                            "expect an immediate redirect back to the conformance suite",
                        match: "https://*/authorize*",
                        tasks: [
                            {
                                task: "Verify Complete",
                                match: "*/test/*/callback*",
                                comment:
                                    "declaring both this and the next task as optional means this configuration works regardless of whether a url is returned in the direct post response",
                                optional: true,
                                commands: [
                                    ["wait", "id", "submission_complete", 10],
                                ],
                            },
                            {
                                task: "Verify Complete",
                                optional: true,
                                match: "https://*/authorize*",
                            },
                        ],
                    },
                ],
            };

            try {
                const planId = await oidfSuite.createPlan(
                    planName,
                    variant,
                    body,
                );
                createdPlans.push({
                    planId,
                    variant,
                });
            } catch (error: any) {
                const reason = String(
                    error?.response?.data?.error_description ??
                        error?.response?.data?.error ??
                        error?.message ??
                        error,
                );
                throw new Error(
                    `Failed to create required issuer variant ${variant.credential_format}/${variant.vci_authorization_code_flow_variant}: ${reason}`,
                );
            }
        }

        if (createdPlans.length !== ISSUER_VARIANT_MATRIX.length) {
            throw new Error(
                `Full issuer matrix is required. Created ${createdPlans.length}/${ISSUER_VARIANT_MATRIX.length} base plans.`,
            );
        }

        // Validate the static module snapshot against OIDF reality. If it
        // drifted (or was missing), rewrite the snapshot file and fail with a
        // clear "re-run" message so vitest picks up the new entries on the
        // next run.
        const livePlanModules = await oidfSuite.getPlanModules(
            createdPlans[0].planId,
        );
        const liveModuleNames = livePlanModules
            .map((m) => m.testModule)
            .sort((a, b) => a.localeCompare(b));
        const snapshotSorted = [...ISSUER_HAIP_MODULES].sort((a, b) =>
            a.localeCompare(b),
        );
        const snapshotMatches =
            liveModuleNames.length === snapshotSorted.length &&
            liveModuleNames.every((name, idx) => name === snapshotSorted[idx]);
        if (!snapshotMatches) {
            writeFileSync(
                SNAPSHOT_PATH,
                `${JSON.stringify(liveModuleNames, null, 2)}\n`,
            );
            const missing = liveModuleNames.filter(
                (name) => !ISSUER_HAIP_MODULES.includes(name),
            );
            const extra = ISSUER_HAIP_MODULES.filter(
                (name) => !liveModuleNames.includes(name),
            );
            throw new Error(
                `Issuer module snapshot drifted and was rewritten at ${SNAPSHOT_PATH}. ` +
                    `Added: [${missing.join(", ")}]. Removed: [${extra.join(", ")}]. ` +
                    `Please re-run the test so vitest picks up the new module list.`,
            );
        }

        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        // Enable HTTPS with self-signed certificate.
        // Keep TLS 1.2+ enabled so OIDF insecure-cipher probes reach cipher
        // negotiation (instead of failing earlier on protocol version), while
        // restricting TLS 1.2 suites to modern FAPI-compatible options.
        const httpsOptions = {
            key: readFileSync(resolve(__dirname, "../key.pem")),
            cert: readFileSync(resolve(__dirname, "../cert.pem")),
            minVersion: "TLSv1.2" as const,
            maxVersion: "TLSv1.3" as const,
            // FAPI2 SP 5.2.2 permitted TLS 1.2 suites, plus TLS 1.3 defaults.
            ciphers: [
                "TLS_AES_128_GCM_SHA256",
                "TLS_AES_256_GCM_SHA384",
                "TLS_CHACHA20_POLY1305_SHA256",
                "ECDHE-ECDSA-AES128-GCM-SHA256",
                "ECDHE-ECDSA-AES256-GCM-SHA384",
                "ECDHE-RSA-AES128-GCM-SHA256",
                "ECDHE-RSA-AES256-GCM-SHA384",
            ].join(":"),
            honorCipherOrder: true,
        };

        app = moduleFixture.createNestApplication<NestExpressApplication>({
            httpsOptions,
        });

        // Use Pino logger for all NestJS logging (same as main.ts)
        app.useLogger(app.get(Logger));
        app.useGlobalPipes(new ValidationPipe());

        const configService = app.get(ConfigService);
        const tmpFolder = resolve(__dirname, "../../../../tmp");
        configService.set("FOLDER", tmpFolder);
        configService.set("CONFIG_FOLDER", configFolder);
        configService.set("PUBLIC_URL", `https://${PUBLIC_DOMAIN}`);
        configService.set("INTERNAL_URL", "https://localhost:3000");
        configService.set("CONFIG_IMPORT_MODE", "create");
        configService.set("LOG_LEVEL", "debug");

        await app.init();
        await app.listen(3000, "0.0.0.0");

        // Get client credentials
        const client = readConfig<{ clientId: string; secret: string }>(
            join(configFolder, "haip/clients/test.json"),
        );
        const clientId = client.clientId;
        const clientSecret = getDefaultSecret(client.secret);

        // Acquire JWT token using client credentials over HTTPS.
        const tokenResponse = await axiosBackendInstance
            .post<{
                access_token: string;
            }>("/api/oauth2/token", {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: "client_credentials",
            })
            .catch((err) => {
                console.log(err);
                throw new Error(err);
            });

        authToken = tokenResponse.data.access_token;
        expect(authToken).toBeDefined();
    });

    afterAll(async () => {
        if (shouldExportOidfLogs()) {
            for (const { planId, variant } of createdPlans) {
                if (!executedPlanIds.has(planId)) {
                    console.log(
                        `Skipping OIDF log export for matrix-only plan ${planId} (${variant.credential_format}/${variant.vci_authorization_code_flow_variant})`,
                    );
                    continue;
                }

                const outputDir = resolve(
                    __dirname,
                    `../../../../tmp/oidf-logs/${planId}`,
                );

                try {
                    await oidfSuite.storeLog(planId, outputDir);
                    console.log(
                        `Test log extracted to: ${outputDir} (${variant.credential_format}/${variant.vci_authorization_code_flow_variant})`,
                    );
                } catch (error) {
                    console.error(
                        `Failed to export OIDF logs for plan ${planId}:`,
                        error,
                    );
                }
            }
        } else {
            console.log(
                "Skipping OIDF log export because OIDF_EXPORT_LOGS is disabled.",
            );
        }

        if (app) {
            await app.close();
        }
    }, 30000);

    // ============================================================================
    // MODULE EXECUTION MATRIX
    // Execute issuer modules through a single loop so coverage and report export
    // stay consistent as module/variant combinations evolve.
    // ============================================================================

    type IssuerModuleCase = {
        moduleName: string;
        expectedResults: ReadonlyArray<"PASSED" | "WARNING">;
        triggerOffer?: boolean;
        credentialConfigurationIdForVariant?: (
            variant: IssuerVariant,
        ) => string;
        waitOptions?: NonNullable<Parameters<OIDFSuite["waitForFinished"]>[1]>;
    };

    const DEFAULT_ISSUER_MODULE_CASE: Omit<IssuerModuleCase, "moduleName"> = {
        expectedResults: ["PASSED"],
        triggerOffer: true,
    };

    // Modules that sleep until the code / request_uri lifetime (60s) elapsed.
    const EXPIRY_WAIT_OPTIONS = {
        maxAttempts: 1000,
        noProgressAttempts: 600,
        waitingNoProgressAttempts: 600,
    };

    const ISSUER_MODULE_CASE_OVERRIDES: Record<
        string,
        Partial<IssuerModuleCase>
    > = {
        "oid4vci-1_0-issuer-metadata-test": {
            triggerOffer: false,
        },
        "oid4vci-1_0-issuer-metadata-test-signed": {
            triggerOffer: false,
        },
        "fapi2-security-profile-final-ensure-token-endpoint-fails-with-expired-auth-code":
            { waitOptions: EXPIRY_WAIT_OPTIONS },
        "fapi2-security-profile-final-par-attempt-to-use-expired-request_uri": {
            waitOptions: EXPIRY_WAIT_OPTIONS,
        },
    };

    const buildIssuerModuleCase = (moduleName: string): IssuerModuleCase => {
        const normalizedName = moduleName.toLowerCase();

        const baseCase: IssuerModuleCase = {
            moduleName,
            ...DEFAULT_ISSUER_MODULE_CASE,
        };

        // FAPI2 WARNINGs cover optional checks (e.g. DPoP jti replay, token revocation on code reuse).
        if (
            normalizedName.includes("metadata") ||
            normalizedName.startsWith(FAPI2_SECURITY_PROFILE_FINAL_PREFIX)
        ) {
            baseCase.triggerOffer = false;
            baseCase.expectedResults = ["PASSED", "WARNING"];
        }
        return {
            ...baseCase,
            ...ISSUER_MODULE_CASE_OVERRIDES[moduleName],
        };
    };

    /**
     * Per-module outcome captured by each variant's `beforeAll`. Looked up
     * by the per-module `it()` blocks for assertions, so vitest reports one
     * pass/fail entry per (variant, module) combination.
     */
    type ModuleOutcome =
        | { kind: "ok"; result: string; status: string; durationMs: number }
        | { kind: "error"; error: Error; durationMs: number };

    const buildSkipReason = (
        moduleName: string,
        variant: IssuerVariant,
    ): string | undefined => {
        const explicitReason =
            EXPLICITLY_SKIPPED_ISSUER_MODULES.get(moduleName);
        if (explicitReason) {
            return explicitReason;
        }
        if (
            variant.vci_authorization_code_flow_variant ===
                "issuer_initiated" &&
            ISSUER_INITIATED_SKIPPED_MODULES.has(moduleName)
        ) {
            return ISSUER_INITIATED_SKIPPED_MODULES.get(moduleName);
        }
        if (
            MODULE_FILTERS.length > 0 &&
            !MODULE_FILTERS.some((filterValue: string) =>
                moduleName.includes(filterValue),
            )
        ) {
            return "filtered out by VITE_OIDF_MODULES";
        }
        if (MODULE_PATTERN && !MODULE_PATTERN.test(moduleName)) {
            return "filtered out by VITE_OIDF_MODULE_PATTERN";
        }
        return undefined;
    };

    const runModuleForVariant = async (
        planId: string,
        variant: IssuerVariant,
        moduleName: string,
        moduleCase: IssuerModuleCase,
    ): Promise<ModuleOutcome> => {
        const variantLabel = `${variant.credential_format}/${variant.vci_authorization_code_flow_variant}`;
        const startedAt = Date.now();
        let testInstance: TestInstance | undefined;
        try {
            testInstance = await oidfSuite.startTest(planId, moduleName);
            console.log(
                `Test details (${variantLabel}/${moduleName}): ${OIDF_URL}/log-detail.html?log=${testInstance.id}`,
            );

            const shouldTriggerOffer =
                moduleCase.triggerOffer !== false &&
                variant.vci_authorization_code_flow_variant ===
                    "issuer_initiated";

            if (shouldTriggerOffer) {
                await sendOfferToTestRunner(
                    testInstance,
                    moduleCase.credentialConfigurationIdForVariant?.(variant) ??
                        getCredentialConfigurationIdForVariant(variant),
                );
            }

            const logResult = await oidfSuite.waitForFinished(
                testInstance.id,
                moduleCase.waitOptions,
            );
            const durationMs = Date.now() - startedAt;
            console.log(
                `Module finished (${variantLabel}/${moduleName}) in ${durationMs}ms → result=${logResult.result} status=${logResult.status}`,
            );
            return {
                kind: "ok",
                result: logResult.result,
                status: logResult.status,
                durationMs,
            };
        } catch (error) {
            const durationMs = Date.now() - startedAt;
            const wrapped =
                error instanceof Error ? error : new Error(String(error));

            if (testInstance?.id) {
                const failedOutputDir = resolve(
                    __dirname,
                    `../../../../tmp/oidf-logs/failed/${testInstance.id}`,
                );
                try {
                    const failedLogPath = await oidfSuite.storeTestLog(
                        testInstance.id,
                        failedOutputDir,
                    );
                    console.error(
                        `Failed test log extracted to: ${failedLogPath} (${variantLabel}/${moduleName})`,
                    );
                } catch (exportError) {
                    console.error(
                        `Failed to export per-test OIDF log for ${moduleName} (${testInstance.id}):`,
                        exportError,
                    );
                }
            }

            console.error(
                `Module errored (${variantLabel}/${moduleName}) after ${durationMs}ms: ${wrapped.message}`,
            );
            return { kind: "error", error: wrapped, durationMs };
        }
    };

    // Per-variant describes register one `it()` per module so vitest reports
    // a separate pass/fail line for every (variant, module) combination.
    // Each variant's `beforeAll` runs its modules sequentially against its
    // dedicated plan; the four variant chains run in parallel via
    // `describe.concurrent`.
    for (const variant of ISSUER_VARIANT_MATRIX) {
        const variantLabel = `${variant.credential_format} / ${variant.vci_authorization_code_flow_variant}`;

        describe.concurrent(variantLabel, () => {
            const outcomes = new Map<string, ModuleOutcome>();
            let variantBootstrapError: Error | undefined;

            beforeAll(async () => {
                const planEntry = createdPlans.find(
                    (entry) => entry.variant === variant,
                );
                if (!planEntry) {
                    variantBootstrapError = new Error(
                        `No plan was created for variant ${variantLabel}`,
                    );
                    return;
                }

                for (const moduleName of ISSUER_HAIP_MODULES) {
                    const moduleCase = buildIssuerModuleCase(moduleName);
                    if (buildSkipReason(moduleName, variant)) {
                        continue;
                    }
                    outcomes.set(
                        moduleName,
                        await runModuleForVariant(
                            planEntry.planId,
                            variant,
                            moduleName,
                            moduleCase,
                        ),
                    );
                }
            }, 3_600_000);

            for (const moduleName of ISSUER_HAIP_MODULES) {
                const moduleCase = buildIssuerModuleCase(moduleName);
                const skipReason = buildSkipReason(moduleName, variant);
                if (skipReason) {
                    test.skip(`${moduleName} (${skipReason})`, () => {});
                    continue;
                }

                test(moduleName, () => {
                    if (variantBootstrapError) {
                        throw variantBootstrapError;
                    }
                    const outcome = outcomes.get(moduleName);
                    if (!outcome) {
                        throw new Error(
                            `Module ${moduleName} did not run for variant ${variantLabel}`,
                        );
                    }
                    if (outcome.kind === "error") {
                        throw outcome.error;
                    }
                    expect(
                        moduleCase.expectedResults,
                        `result=${outcome.result} status=${outcome.status} (expected one of ${moduleCase.expectedResults.join(", ")})`,
                    ).toContain(outcome.result);
                });
            }
        });
    }
});
