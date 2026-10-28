import { crc32, deflateRawSync } from 'node:zlib'

/**
 * Builds small Word, PowerPoint and Excel files for tests: a ZIP archive written by hand (parts
 * deflated, except where a test asks for stored ones), holding only the XML parts the reader needs.
 */

export function zip(parts: Record<string, string>, options: { store?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(parts)) {
    const data = Buffer.from(content, 'utf8')
    const packed = options.store ? data : deflateRawSync(data)
    const nameBytes = Buffer.from(name, 'utf8')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(options.store ? 0 : 8, 8)
    header.writeUInt32LE(crc32(data), 14)
    header.writeUInt32LE(packed.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(options.store ? 0 : 8, 10)
    entry.writeUInt32LE(crc32(data), 16)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    local.push(header, nameBytes, packed)
    central.push(entry, nameBytes)
    offset += header.length + nameBytes.length + packed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(parts).length, 8)
  end.writeUInt16LE(Object.keys(parts).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Uint8Array.from(Buffer.concat([...local, directory, end]))
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** A Word body: write paragraphs and tables with w: elements. */
export function docx(body: string, extra: Record<string, string> = {}): Uint8Array<ArrayBuffer> {
  return zip({ 'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}</w:body></w:document>`, ...extra })
}

/** Slides in the order given (listed in presentation.xml in that order), each with optional notes. */
export function pptx(slides: Array<{ part: string; text: string[]; notes?: string[] }>): Uint8Array<ArrayBuffer> {
  const paragraphs = (lines: string[]) => lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join('')
  const parts: Record<string, string> = {
    'ppt/presentation.xml': `<p:presentation ${A} ${R}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships>${slides.map((slide, i) => `<Relationship Id="rId${i + 1}" Target="slides/${slide.part}"/>`).join('')}</Relationships>`,
  }
  slides.forEach((slide, i) => {
    parts[`ppt/slides/${slide.part}`] = `<p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs(slide.text)}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    if (slide.notes) {
      parts[`ppt/slides/_rels/${slide.part}.rels`] = `<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`
      parts[`ppt/notesSlides/notesSlide${i + 1}.xml`] = `<p:notes ${A}><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs([String(i + 1), ...slide.notes])}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
    }
  })
  return zip(parts)
}

/** Sheets of cells by reference ("A1"); strings are shared, numbers and booleans are not. */
export function xlsx(sheets: Array<{ name: string; cells: Record<string, string | number | boolean> }>): Uint8Array<ArrayBuffer> {
  const strings: string[] = []
  const parts: Record<string, string> = {
    'xl/workbook.xml': `<workbook ${R}><sheets>${sheets.map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  }
  sheets.forEach((sheet, i) => {
    const rows = new Map<number, string[]>()
    for (const [reference, value] of Object.entries(sheet.cells)) {
      const row = Number(/\d+/.exec(reference)![0])
      let cell: string
      if (typeof value === 'string') {
        strings.push(value)
        cell = `<c r="${reference}" t="s"><v>${strings.length - 1}</v></c>`
      } else if (typeof value === 'boolean') cell = `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`
      else cell = `<c r="${reference}"><v>${value}</v></c>`
      rows.set(row, [...(rows.get(row) ?? []), cell])
    }
    const xml = [...rows.entries()]
      .sort(([a], [b]) => a - b)
      .map(([row, cells]) => `<row r="${row}">${cells.join('')}</row>`)
      .join('')
    parts[`xl/worksheets/sheet${i + 1}.xml`] = `<worksheet><sheetData>${xml}</sheetData></worksheet>`
  })
  parts['xl/sharedStrings.xml'] = `<sst>${strings.map((value) => `<si><t xml:space="preserve">${value}</t></si>`).join('')}</sst>`
  return zip(parts)
}
