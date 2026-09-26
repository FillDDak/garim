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

describe('office formats', () => {
  const opts = { mode: 'token' as const, tokenLang: 'ko' as const, partialRedact: true }
  it('xlsx shared strings', async () => {
    const zip = new JSZip()
    zip.file('xl/sharedStrings.xml', '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>성명</t></si><si><t>김철수</t></si><si><r><t>010-1111-</t></r><r><t>2222</t></r></si></sst>')
    const r = await processOffice(await zip.generateAsync({ type: 'arraybuffer' }), 'xlsx', defaultDetectOptions(), opts, [])
    const out = await (await JSZip.loadAsync(await r.blob.arrayBuffer())).file('xl/sharedStrings.xml')!.async('string')
    expect(out).not.toContain('김철수')
    expect(out).not.toContain('2222')
  })
  it('pptx slides', async () => {
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>이메일 hong@test.co.kr</a:t></a:r></a:p></p:sld>')
    const r = await processOffice(await zip.generateAsync({ type: 'arraybuffer' }), 'pptx', defaultDetectOptions(), opts, [])
    const out = await (await JSZip.loadAsync(await r.blob.arrayBuffer())).file('ppt/slides/slide1.xml')!.async('string')
    expect(out).toContain('[이메일_1]')
  })
  it('hwpx sections, preview text and stored mimetype', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/hwp+zip')
    zip.file('Contents/section0.xml', '<?xml version="1.0"?><hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:t>주민번호 900101-1234568<hp:tab/>끝</hp:t></hp:run></hp:p></hs:sec>')
    zip.file('Preview/PrvText.txt', '주민번호 900101-1234568')
    const r = await processOffice(await zip.generateAsync({ type: 'arraybuffer' }), 'hwpx', defaultDetectOptions(), opts, [])
    const z2 = await JSZip.loadAsync(await r.blob.arrayBuffer())
    const sec = await z2.file('Contents/section0.xml')!.async('string')
    expect(sec).toContain('[주민번호_1]')
    expect(sec).toContain('<hp:tab/>')
    expect(await z2.file('Preview/PrvText.txt')!.async('string')).not.toContain('1234568')
    expect(Object.keys(z2.files)[0]).toBe('mimetype')
  })
})

describe('hidden personal data in documents', () => {
  it('scrubs tracked-change authors and mailto links', async () => {
    const zip = new JSZip()
    zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:ins w:id="1" w:author="홍길동" w:date="2026-01-01"><w:r><w:t>안녕</w:t></w:r></w:ins></w:p></w:body></w:document>`)
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships><Relationship Id="rId9" Type="hyperlink" Target="mailto:gildong@corp.co.kr" TargetMode="External"/></Relationships>')
    const r = await processOffice(await zip.generateAsync({ type: 'arraybuffer' }), 'docx', defaultDetectOptions(), { mode: 'token', tokenLang: 'ko', partialRedact: true }, [])
    const z = await JSZip.loadAsync(await r.blob.arrayBuffer())
    expect(await z.file('word/document.xml')!.async('string')).not.toContain('홍길동')
    const rels = await z.file('word/_rels/document.xml.rels')!.async('string')
    expect(rels).not.toContain('gildong')
    expect(r.notes.join()).toContain('작성자')
  })
})

describe('xlsx numeric cells', () => {
  it('masks RRN/phone numbers stored as numbers', async () => {
    const zip = new JSZip()
    zip.file('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>9001011234568</v></c><c r="B1" s="2"><v>1012345678</v></c><c r="C1"><v>2024</v></c></row></sheetData></worksheet>')
    const r = await processOffice(await zip.generateAsync({ type: 'arraybuffer' }), 'xlsx', defaultDetectOptions(), { mode: 'token', tokenLang: 'ko', partialRedact: true }, [])
    const out = await (await JSZip.loadAsync(await r.blob.arrayBuffer())).file('xl/worksheets/sheet1.xml')!.async('string')
    expect(out).not.toContain('9001011234568')
    expect(out).not.toContain('1012345678')
    expect(out).toContain('<v>2024</v>')
    expect(out).toContain('<c r="B1" s="2" t="inlineStr"><is><t>[전화_1]</t></is></c>')
    expect(r.masked.mapping.map((m) => m.type)).toEqual(expect.arrayContaining(['rrn', 'phone']))
  })
})
