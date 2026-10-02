import React from "react";
import CodeBlock from "@theme/CodeBlock";
import requestBody from "@site/docs/generated/presentation-request.json";
import type { RequestField } from "../../../scripts/request-docs/model";
import { renderRequestBody } from "../../../scripts/request-docs/render";

const model = requestBody as RequestField;

/** Annotated JSONC request shape, generated from the backend's Zod DTO schema. */
export default function RequestBodyJson(): React.ReactElement {
    // Prism's JSON5 grammar highlights JSONC comments; its JSON grammar does not.
    return <CodeBlock language="json5">{renderRequestBody(model)}</CodeBlock>;
}
