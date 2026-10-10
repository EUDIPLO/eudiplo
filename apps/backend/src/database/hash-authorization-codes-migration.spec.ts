import { DataSource } from "typeorm";
import {
    hashAuthorizationCodesContract,
    hashAuthorizationCodesEntities,
} from "../../test/persistence/hash-authorization-codes.contract.js";

hashAuthorizationCodesContract(() =>
    new DataSource({
        type: "better-sqlite3",
        database: ":memory:",
        entities: hashAuthorizationCodesEntities,
        synchronize: true,
    }).initialize(),
);
