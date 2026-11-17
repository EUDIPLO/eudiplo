import { Module } from "@nestjs/common";
import { EudiHubModule } from "./eudi-hub/eudi-hub.module.js";

/**
 * Registrars that issue access and registration certificates to EUDIPLO's
 * relying parties. Each registrar is an adapter module in its own folder
 * (`eudi-hub/` for the German EUDI Hub) with its client, its endpoints under
 * `/api/<registrar>` and its request DTOs. Every adapter stores what it
 * obtains through the registrar-neutral storage services of
 * `RegistrarStorageModule`, which apply the same checks to every
 * registrar. See "A registrar adapter" in the
 * backend architecture guide.
 */
@Module({
    imports: [EudiHubModule],
})
export class RegistrarModule {}
