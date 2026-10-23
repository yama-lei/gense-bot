import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractDocument } from '../src/documents.ts'
import { docxFile, pdfFile, pptxFile, xlsxFile } from './fixtures.ts'

test('R9: Word paragraphs, with table cells tab-separated', async () => {
  assert.equal(await extractDocument('docx', docxFile()), '第一段 & 续\n甲\t乙\n最后')
})

test('R9: Excel sheets as tab-separated rows, shared strings resolved, gaps kept', async () => {
  assert.equal(await extractDocument('xlsx', xlsxFile()), '## 工作表：成绩\n姓名\t分数\n张三\t\t95')
})

test('R9: PowerPoint slides in order, with speaker notes', async () => {
  assert.equal(await extractDocument('pptx', pptxFile()), '## 第 1 页\n开场\n要点一\n\n备注：\n讲稿\n\n## 第 2 页\n第二页标题')
})

test('R9: PDF text by page; a file without text says so', async () => {
  assert.equal(await extractDocument('pdf', pdfFile('Hello PDF')), '## 第 1 页\nHello PDF')
  await assert.rejects(extractDocument('pdf', pdfFile('')), /没有文字层/)
  await assert.rejects(extractDocument('docx', new Uint8Array([1, 2, 3])), /已损坏/)
})
