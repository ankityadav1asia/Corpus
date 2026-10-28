import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { extractOfficeText, OfficeFileError } from '@/server/ingestion/office'

import { docx, pptx, xlsx, zip } from './helpers/office'

describe('Word documents', () => {
  it('keeps headings, list items, tables and notes, and skips deleted text', () => {
    const file = docx(
      [
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Field guide</w:t></w:r></w:p>',
        '<w:p><w:r><w:t xml:space="preserve">Bees &amp; wasps </w:t></w:r><w:r><w:t>pollinate.</w:t></w:r><w:del><w:r><w:delText>Old claim.</w:delText></w:r></w:del></w:p>',
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Clover</w:t></w:r></w:p>',
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Plant</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Visits</w:t></w:r></w:p></w:tc></w:tr>',
        '<w:tr><w:tc><w:p><w:r><w:t>Thyme</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      ].join(''),
      { 'word/footnotes.xml': '<w:footnotes><w:footnote><w:p><w:r><w:t>Counted in May.</w:t></w:r></w:p></w:footnote></w:footnotes>' },
    )
    assert.equal(extractOfficeText(file, '.docx', 'guide.docx'), '# Field guide\nBees & wasps pollinate.\n- Clover\nPlant | Visits\nThyme | 12\n\nCounted in May.')
  })

  it('reads parts that are stored without compression', () => {
    const file = zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Stored</w:t></w:r></w:p></w:body></w:document>' }, { store: true })
    assert.equal(extractOfficeText(file, '.docx', 'stored.docx'), 'Stored')
  })
})

describe('PowerPoint presentations', () => {
  it('reads slides in presentation order, each with its speaker notes', () => {
    const file = pptx([
      { part: 'slide2.xml', text: ['Agenda', 'Why bees matter'] },
      { part: 'slide1.xml', text: ['Results'], notes: ['Mention the May count.'] },
    ])
    assert.equal(extractOfficeText(file, '.pptx', 'talk.pptx'), '## Slide 1\nAgenda\nWhy bees matter\n\n## Slide 2\nResults\n\nNotes: Mention the May count.')
  })
})

describe('Excel workbooks', () => {
  it('lists each sheet as rows of column: value pairs, with shared strings, numbers and booleans', () => {
    const file = xlsx([
      { name: 'Counts', cells: { A1: 'Plant', B1: 'Visits', C1: 'Native', A2: 'Thyme', B2: 12, C2: true, A4: 'Clover', C4: false } },
      { name: 'Empty', cells: {} },
    ])
    assert.equal(
      extractOfficeText(file, '.xlsx', 'counts.xlsx'),
      '## Sheet: Counts\n\nTable columns: Plant, Visits, Native\n\nRow 1: Plant: Thyme | Visits: 12 | Native: TRUE\nRow 2: Plant: Clover | Visits:  | Native: FALSE',
    )
  })
})

describe('untrusted Office files', () => {
  it('explains password-protected, legacy and damaged files', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
    assert.throws(() => extractOfficeText(ole, '.docx', 'secret.docx'), /"secret\.docx" is password-protected or in the old binary format/)
    assert.throws(() => extractOfficeText(new TextEncoder().encode('just text'), '.xlsx', 'fake.xlsx'), /"fake\.xlsx" is not a valid Excel workbook/)
    assert.throws(() => extractOfficeText(zip({ 'readme.txt': 'hi' }), '.pptx', 'empty.pptx'), /Could not read "empty\.pptx"\. The PowerPoint presentation may be damaged \(no slides\)/)

    const damaged = docx('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>')
    damaged[50] = damaged[50]! ^ 0xff // inside the deflated document part (after the 30-byte header and the name)
    assert.throws(() => extractOfficeText(damaged, '.docx', 'damaged.docx'), OfficeFileError)
  })

  it('refuses a part that would inflate beyond its declared size or the per-part cap', () => {
    const big = 'a'.repeat(1_000_000)
    const file = docx(`<w:p><w:r><w:t>${big}</w:t></w:r></w:p>`)
    // Understate the uncompressed size in the central directory: inflation stops there.
    const view = new DataView(file.buffer)
    let at = file.length - 22
    at = view.getUint32(at + 16, true)
    view.setUint32(at + 24, 1000, true)
    assert.throws(() => extractOfficeText(file, '.docx', 'bomb.docx'), /may be damaged/)

    // Overstate it past the cap: refused before anything is inflated.
    view.setUint32(at + 24, 65 * 1024 * 1024, true)
    assert.throws(() => extractOfficeText(file, '.docx', 'bomb.docx'), /too large once unpacked/)
  })
})
