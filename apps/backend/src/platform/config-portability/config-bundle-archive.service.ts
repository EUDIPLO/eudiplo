import { ConfigBundleCodec } from "@eudiplo/config-format/config-bundle.js";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { ConfigBundle } from "./config-resource.types.js";
@Injectable()
export class ConfigBundleArchiveService {
    private readonly codec = new ConfigBundleCodec();
    encode(bundle: ConfigBundle): Buffer {
        try {
            return this.codec.encode(bundle);
        } catch (error) {
            throw new BadRequestException(String(error));
        }
    }
    decode(input: Buffer): ConfigBundle {
        try {
            return this.codec.decode(input);
        } catch (error) {
            throw new BadRequestException(String(error));
        }
    }
}
