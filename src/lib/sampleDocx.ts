import JSZip from 'jszip'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Builds a small, valid .docx with fictional personal data for the document demo. */
export async function makeSampleDocx(): Promise<File> {
  const para = (text: string, bold = false) =>
    `<w:p><w:r>${bold ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
  const cell = (t: string) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${para(t)}</w:tc>`
  const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join('')}</w:tr>`
  const border = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:color="999999"/>`).join('') + '</w:tblBorders>'
  const body = [
    para('고객 상담 기록', true),
    para('상담일: 2026년 9월 20일 / 상담원: 윤하늘 매니저'),
    `<w:tbl><w:tblPr>${border}</w:tblPr>${row('성명', '송지아', '연락처', '010-4321-8765')}${row('생년월일', '1991-07-22', '이메일', 'jia.song@example.org')}${row('주소', '대전광역시 유성구 대학로 99', '환불 계좌', '하나은행 123-456789-01234')}</w:tbl>`,
    para(''),
    para('상담 내용: 송지아 고객님이 주문 상품의 배송 지연으로 환불을 요청하셨습니다. 카드 4111-1111-1111-1111 결제 건은 취소 처리 예정입니다.'),
    para('후속 조치: 윤하늘 매니저가 내일 오전 중 고객에게 회신합니다.'),
  ].join('')
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
  )
  zip.file(
    'docProps/core.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>고객 상담 기록</dc:title><dc:creator>윤하늘</dc:creator><cp:lastModifiedBy>윤하늘</cp:lastModifiedBy></cp:coreProperties>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  )
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
  return new File([blob], '예시_고객상담기록.docx', { type: blob.type })
}
