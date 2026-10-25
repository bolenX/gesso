// How Gesso signs what it makes. No watermark: files carry the standard XMP
// "creator tool" field (Photoshop shows it under File > File Info as the
// application), and manifests name their generator.

export const GESSO_VERSION = "0.10.0";
export const GENERATOR = `Gesso ${GESSO_VERSION}`;
export const GESSO_URL = "https://github.com/bolenX/gesso";

/** A minimal XMP packet recording Gesso as the creator tool, plus the document ID. */
export function xmpPacket(docId: string, revision: number): string {
  const now = new Date().toISOString();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"`,
    ` xmp:CreatorTool="${esc(GENERATOR)}" xmp:CreateDate="${now}" xmp:ModifyDate="${now}" xmp:MetadataDate="${now}">`,
    `<dc:source>${esc(`${docId} rev ${revision}`)}</dc:source>`,
    "</rdf:Description>",
    "</rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("");
}
