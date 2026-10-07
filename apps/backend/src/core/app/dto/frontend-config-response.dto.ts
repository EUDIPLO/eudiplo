import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

class GrafanaConfigDto {
    @ApiPropertyOptional({
        description: "Base URL of the Grafana instance",
        example: "http://localhost:3001",
    })
    url?: string;

    @ApiProperty({
        description: "UID of the Tempo data source in Grafana",
        example: "tempo",
    })
    tempoUid!: string;

    @ApiProperty({
        description: "UID of the Loki data source in Grafana",
        example: "loki",
    })
    lokiUid!: string;
}

export class FrontendConfigResponseDto {
    @ApiProperty({ description: "Grafana observability configuration" })
    grafana!: GrafanaConfigDto;

    @ApiProperty({
        description: "Active startup configuration import mode",
        enum: ["disabled", "create", "upsert", "replace"],
        example: "upsert",
    })
    configImportMode!: "disabled" | "create" | "upsert" | "replace";

    @ApiProperty({
        description:
            "Public URL of the instance (PUBLIC_URL). Wallets and other verifiers reach the wallet-facing endpoints, such as trust lists, under this URL, which can differ from the URL the client signed in with.",
        example: "https://eudiplo.example.com",
    })
    publicUrl!: string;
}
