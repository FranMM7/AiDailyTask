/** Extract readable text from word/document.xml without executing Office content. */
export async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Invalid DOCX archive");
  const entries = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let entry = 0; entry < entries; entry++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (name === "word/document.xml") {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(start, start + compressedSize);
      let xmlBytes: Uint8Array;
      if (method === 0) xmlBytes = compressed;
      else if (method === 8) {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        xmlBytes = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error("Unsupported DOCX compression");
      const xml = new DOMParser().parseFromString(decoder.decode(xmlBytes), "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("Invalid Word document XML");
      return Array.from(xml.getElementsByTagNameNS("*", "p"))
        .map((paragraph) => Array.from(paragraph.getElementsByTagNameNS("*", "t")).map((n) => n.textContent ?? "").join(""))
        .join("\n\n")
        .trim();
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("DOCX document body not found");
}
