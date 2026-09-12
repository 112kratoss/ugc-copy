type JsonLdProps = {
    data: Record<string, unknown> | Array<Record<string, unknown>>;
};

/**
 * `JSON.stringify` does not escape `<`, so a value containing `</script>` would
 * close this block early and turn structured data into an injection point. All
 * current callers pass build-time schema constants, but the prop type accepts
 * arbitrary data -- escaping here keeps that from becoming a live XSS the first
 * time a caller passes a post title or profile field. `<` is still valid
 * JSON, so consumers parse the payload unchanged.
 */
function encodeJsonLd(data: JsonLdProps['data']): string {
    return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function JsonLd({ data }: JsonLdProps) {
    return (
        <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: encodeJsonLd(data) }}
        />
    );
}

