const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|xml|html?|ya?ml|srt|vtt|eml|ini|env|conf|cfg|sql|js|jsx|ts|tsx|py|java|kt|go|rb|php|cs|c|cpp|h|hpp|rs|swift|sh|toml|properties)$/i

export function isPlainTextFile(file: File): boolean {
  return TEXT_EXT.test(file.name) || (file.type.startsWith('text/') && !/\.(docx|xlsx|pptx|hwpx|pdf)$/i.test(file.name))
}

/**
 * Decodes text in UTF-8 (with/without BOM) or UTF-16, and falls back to EUC-KR/CP949,
 * which is still what Excel and many Korean systems export by default.
 */
export function decodeBytes(buf: ArrayBuffer): { text: string; encoding: string; bom: boolean } {
  const bytes = new Uint8Array(buf)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', bom: true }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', bom: true }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', bom: true }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', bom: false }
  } catch {
    try {
      return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'euc-kr', bom: false }
    } catch {
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', bom: false }
    }
  }
}

export async function decodeTextFile(file: File) {
  return decodeBytes(await file.arrayBuffer())
}
