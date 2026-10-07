import React from "react";

/**
 * Renders the `backtick` spans of a generated text (schema descriptions,
 * conditions) as inline code; everything else stays plain text.
 */
export default function InlineCode({ text }: { text: string }): React.ReactElement {
    return (
        <>
            {text.split("`").map((part, idx) =>
                idx % 2 === 1 ? (
                    <code key={idx}>{part}</code>
                ) : (
                    <React.Fragment key={idx}>{part}</React.Fragment>
                ),
            )}
        </>
    );
}
