// Renders a JSON-LD structured-data block. Server component — the script is in
// the static HTML at build time, so crawlers read it without executing JS.
export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Structured data is trusted, build-time constant content.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
