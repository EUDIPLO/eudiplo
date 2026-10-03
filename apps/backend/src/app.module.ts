import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { MulterModule } from "@nestjs/platform-express";
import { ScheduleModule } from "@nestjs/schedule";
import { memoryStorage } from "multer";
import { LoggerModule } from "nestjs-pino";
import { AuthModule } from "./auth/auth.module.js";
import { CoreModule } from "./core/core.module.js";
import { CryptoModule } from "./crypto/crypto.module.js";
import { KeyModule } from "./crypto/key/key.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { IssuerModule } from "./issuer/issuer.module.js";
import { VALIDATION_SCHEMA } from "./platform/config/combined.schema.js";
import { ConfigImportModule } from "./platform/config-import/config-import.module.js";
import { ConfigPortabilityModule } from "./platform/config-portability/config-portability.module.js";
import { ConfigResourceCoreModule } from "./platform/config-portability/config-resource-core.module.js";
import { DataEncryptionModule } from "./platform/data-encryption/data-encryption.module.js";
import { LogContextModule } from "./platform/observability/log-context.module.js";
import { createLoggerOptions } from "./platform/observability/logger.factory.js";
import { RegistrarModule } from "./registrar/registrar.module.js";
import { SessionModule } from "./session/session.module.js";
import { StorageModule } from "./storage/storage.module.js";
import { VerifierModule } from "./verifier/verifier.module.js";

@Module({
    imports: [
        ConfigModule.forRoot({
            validationSchema: VALIDATION_SCHEMA,
            isGlobal: true,
            expandVariables: true,
        }),
        EventEmitterModule.forRoot(),
        LoggerModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: createLoggerOptions,
        }),
        LogContextModule,
        // DataEncryptionModule must be imported early to initialize transformers
        // before TypeORM entities are loaded
        DataEncryptionModule,
        CoreModule,
        ConfigResourceCoreModule,
        AuthModule,
        KeyModule.forRoot(),
        MulterModule.register({
            storage: memoryStorage(),
            limits: { fileSize: 5 * 1024 * 1024 },
        }),
        CryptoModule,
        IssuerModule,
        VerifierModule,
        RegistrarModule,
        ScheduleModule.forRoot(),
        SessionModule,
        DatabaseModule,
        StorageModule.forRoot(),
        ConfigPortabilityModule,
        ConfigImportModule,
    ],
    controllers: [],
    providers: [],
})
export class AppModule {}
