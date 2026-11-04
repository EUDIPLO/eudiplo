import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamicModule, Global, Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { LocalFileStorage } from "./adapters/local.storage.js";
import { isMissingObject, S3FileStorage } from "./adapters/s3.storage.js";
import { FileEntity } from "./entities/files.entity.js";
import { FilesService } from "./files.service.js";
import { StorageController } from "./storage.controller.js";
import { FILE_STORAGE, FileStorage } from "./storage.types.js";

type Driver = "local" | "s3";

const logger = new Logger("StorageModule");

/**
 * Fails fast if S3 credentials (static or resolved via the AWS SDK's default
 * provider chain, e.g. IRSA/instance profile) can't actually authenticate.
 *
 * Uses HeadObject on a key that is not expected to exist, rather than
 * HeadBucket/ListBucket, so this only requires the same object-level
 * permissions (s3:GetObject) the app already needs for normal operation
 * (put/get/delete/exists) — a minimally-scoped bucket policy without
 * s3:ListBucket/s3:HeadBucket won't cause a false-positive startup failure.
 * A NotFound/NoSuchKey response means auth succeeded (the object simply
 * doesn't exist); any other error (credentials, access denied, network,
 * wrong bucket/region) fails startup with a clear message instead of
 * surfacing only on the first real upload/download.
 */
export async function verifyS3Access(
    s3: S3Client,
    bucket: string,
): Promise<void> {
    try {
        await s3.send(
            new HeadObjectCommand({
                Bucket: bucket,
                Key: ".eudiplo-storage-startup-check",
            }),
        );
    } catch (error) {
        if (isMissingObject(error)) {
            return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        logger.error(
            `S3 startup check failed for bucket "${bucket}": ${reason}`,
        );
        throw new Error(
            `Unable to authenticate to S3 bucket "${bucket}": ${reason}`,
            { cause: error },
        );
    }
}

@Global()
@Module({})
export class StorageModule {
    static forRoot(): DynamicModule {
        return {
            module: StorageModule,
            imports: [TypeOrmModule.forFeature([FileEntity])],
            controllers: [StorageController],
            providers: [
                FilesService,
                {
                    provide: FILE_STORAGE,
                    inject: [ConfigService],
                    useFactory: async (
                        cfg: ConfigService,
                    ): Promise<FileStorage> => {
                        const driver = cfg.get<Driver>("STORAGE_DRIVER");
                        if (driver === "s3") {
                            const accessKeyId =
                                cfg.get<string>("S3_ACCESS_KEY_ID");
                            const secretAccessKey = cfg.get<string>(
                                "S3_SECRET_ACCESS_KEY",
                            );
                            const bucket = cfg.get<string>("S3_BUCKET")!;
                            const s3 = new S3Client({
                                region: cfg.get<string>("S3_REGION"),
                                endpoint: cfg.get<string>("S3_ENDPOINT"),
                                forcePathStyle: cfg.get<boolean>(
                                    "S3_FORCE_PATH_STYLE",
                                ),
                                ...(accessKeyId && secretAccessKey
                                    ? {
                                          credentials: {
                                              accessKeyId,
                                              secretAccessKey,
                                          },
                                      }
                                    : {}),
                            });
                            await verifyS3Access(s3, bucket);
                            logger.log(`S3 storage ready (bucket: ${bucket})`);
                            return new S3FileStorage(s3, bucket);
                        }
                        // local
                        return new LocalFileStorage(
                            cfg.getOrThrow<string>("LOCAL_STORAGE_DIR"),
                        );
                    },
                },
            ],
            exports: [FilesService],
        };
    }
}
