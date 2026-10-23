// Small real documents for the R9 tests, built in code so the repository holds no binaries.
import { strToU8, zipSync } from 'fflate'

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))

export const docxFile = () =>
  zip({
    'word/document.xml':
      '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' +
      '<w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; 续</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:p><w:r><w:t>最后</w:t></w:r></w:p></w:body></w:document>',
  })

export const xlsxFile = () =>
  zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="成绩" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>姓名</t></si><si><t>分数</t></si><si><t>张三</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>95</v></c></row></sheetData></worksheet>',
  })

export const pptxFile = () =>
  zip({
    'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>第二页标题</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>开场</a:t></a:r></a:p><a:p><a:r><a:t>要点一</a:t></a:r></a:p></p:sld>',
    'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:p><a:r><a:t>讲稿</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>',
  })

/** A one-page PDF whose text layer says `text` (ASCII, Helvetica). */
export function pdfFile(text: string) {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((o, i) => {
    const at = out.length
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return strToU8(out)
}
