import { DataSource } from "typeorm";
import {
    encryptStoredSecretsContract,
    encryptStoredSecretsEntities,
} from "../../test/persistence/encrypt-stored-secrets.contract.js";

encryptStoredSecretsContract(() =>
    new DataSource({
        type: "better-sqlite3",
        database: ":memory:",
        entities: encryptStoredSecretsEntities,
        synchronize: true,
    }).initialize(),
);
