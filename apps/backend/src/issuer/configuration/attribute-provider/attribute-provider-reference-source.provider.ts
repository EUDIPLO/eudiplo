import type { Provider } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import type { ObjectLiteral, Repository } from "typeorm";
import { AttributeProviderReferences } from "./application/attribute-provider-references.js";
import type { AttributeProviderReferenceSource } from "./ports/attribute-provider-reference-source.js";

/**
 * Provider that builds a reference source on the repository of `entity` and
 * registers it with {@link AttributeProviderReferences}. The module that
 * lists it must import `AttributeProviderModule` and
 * `TypeOrmModule.forFeature([entity])`.
 */
export function provideAttributeProviderReferenceSource<
    Entity extends ObjectLiteral,
>(
    source: new (
        repository: Repository<Entity>,
    ) => AttributeProviderReferenceSource,
    entity: new () => Entity,
): Provider {
    return {
        provide: source,
        inject: [getRepositoryToken(entity), AttributeProviderReferences],
        useFactory: (
            repository: Repository<Entity>,
            references: AttributeProviderReferences,
        ) => {
            const instance = new source(repository);
            references.register(instance);
            return instance;
        },
    };
}
