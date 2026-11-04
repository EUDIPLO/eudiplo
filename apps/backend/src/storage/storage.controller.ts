import {
    Controller,
    Get,
    Param,
    Post,
    StreamableFile,
    UploadedFile,
    UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBody, ApiConsumes, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Role } from "../auth/roles/role.enum.js";
import { Secured } from "../auth/secure.decorator.js";
import { Token, TokenPayload } from "../auth/token.decorator.js";
import { FileUploadDto } from "./dto/file-upload.dto.js";
import { StoredObjectResponseDto } from "./dto/stored-object-response.dto.js";
import { FilesService } from "./files.service.js";

/**
 * Storage Controller
 */
@ApiTags("Storage")
@Controller("storage")
export class StorageController {
    /**
     * Constructor
     * @param filesService The files service
     */
    constructor(private readonly filesService: FilesService) {}

    /**
     * Upload files that belong to a tenant like images
     * @param user
     * @param file
     * @returns
     */
    @UseInterceptors(FileInterceptor("file"))
    @Secured([Role.Issuances])
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        type: FileUploadDto,
    })
    @ApiResponse({ status: 200, type: StoredObjectResponseDto })
    @Post()
    upload(
        @Token() user: TokenPayload,
        @UploadedFile() file: Express.Multer.File,
    ) {
        return this.filesService.saveUserUpload(user.entity!.id, file, true);
    }

    /**
     * Get a file and stream it
     */
    @Get(":key")
    @ApiResponse({
        status: 200,
        description: "Binary file stream",
        content: {
            "application/octet-stream": {
                schema: { type: "string", format: "binary" },
            },
        },
    })
    async download(@Param("key") key: string) {
        // getStream answers a missing file with a NotFoundException; other
        // storage errors pass on as 500 and are logged.
        const stream = await this.filesService.getStream(key);
        //TODO: check if it should be attachment or not
        return new StreamableFile(stream.stream, {
            disposition: "attachment",
            type: stream.contentType,
            length: stream.size,
        });
    }
}
