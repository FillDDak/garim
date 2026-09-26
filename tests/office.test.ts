// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { processOffice } from '../src/lib/files/office'
import { defaultDetectOptions } from '../src/core/engine'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

async function makeDocx(body: string) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`)
  zip.file('docProps/core.xml', '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:creator>홍길동</dc:creator><cp:lastModifiedBy>홍길동</cp:lastModifiedBy></cp:coreProperties>')
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('office', () => {
  it('masks entities split across runs and scrubs metadata', async () => {
    const buf = await makeDocx(
      '<w:p><w:r><w:t>담당: </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>김민</w:t></w:r><w:r><w:t>수 과장님 010-1234-</w:t></w:r><w:r><w:t>5678</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>성명</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>이서연</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    )
    const r = await processOffice(buf, 'docx', defaultDetectOptions(), { mode: 'token', tokenLang: 'ko', partialRedact: true }, [])
    const zip = await JSZip.loadAsync(await r.blob.arrayBuffer())
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).not.toContain('김민')
    expect(xml).not.toContain('5678')
    expect(xml).toContain('[이름_1]')
    expect(xml).toContain('[전화_1]')
    expect(xml).toContain('<w:b/>')
    expect(xml).not.toContain('이서연')
    const core = await zip.file('docProps/core.xml')!.async('string')
    expect(core).not.toContain('홍길동')
  })
})
