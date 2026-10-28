import { crc32, inflateRawSync } from 'node:zlib'

import { LIMITS } from '@/lib/constants'
import { rowsToText } from '@/server/ingestion/text'

/**
 * Word, PowerPoint and Excel files (DOCX, PPTX, XLSX) are ZIP archives of XML parts. This reads the
 * archive with Node's own zlib and pulls the text out of the parts that hold it, keeping the
 * structure that helps retrieval: headings and list items in documents, one section per slide (with
 * its speaker notes), and spreadsheet rows in the same "column: value" form as CSV uploads.
 *
 * Archives are untrusted: entry counts, part sizes and the total inflated size are capped before
 * anything is inflated, so a small file cannot expand into gigabytes (a "zip bomb").
 */

export class OfficeFileError extends Error {}

const MAX_ENTRIES = 5_000
/** Inflated size of any one XML part, and of everything read from one file. */
const MAX_PART_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 192 * 1024 * 1024

interface ZipEntry {
  name: string
  method: number
  flags: number
  crc: number
  compressedSize: number
  size: number
  offset: number
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
/** OLE compound files: legacy .doc/.xls/.ppt, and encrypted (password-protected) OOXML. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((byte, i) => bytes[i] === byte)

class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>()
  private inflated = 0
  private readonly view: DataView

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // End of central directory: 22 bytes plus a comment of at most 64 KiB, at the end of the file.
    let end = -1
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (this.view.getUint32(i, true) === 0x06054b50) {
        end = i
        break
      }
    }
    if (end < 0) throw new OfficeFileError('not a ZIP archive')
    const count = this.view.getUint16(end + 10, true)
    let at = this.view.getUint32(end + 16, true)
    if (count === 0xffff || at === 0xffffffff) throw new OfficeFileError('ZIP64 archives are not supported')
    if (count > MAX_ENTRIES) throw new OfficeFileError('too many parts')
    for (let i = 0; i < count; i++) {
      if (at + 46 > bytes.length || this.view.getUint32(at, true) !== 0x02014b50) throw new OfficeFileError('damaged central directory')
      const nameLength = this.view.getUint16(at + 28, true)
      const entry: ZipEntry = {
        flags: this.view.getUint16(at + 8, true),
        method: this.view.getUint16(at + 10, true),
        crc: this.view.getUint32(at + 16, true),
        compressedSize: this.view.getUint32(at + 20, true),
        size: this.view.getUint32(at + 24, true),
        offset: this.view.getUint32(at + 42, true),
        name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      }
      this.entries.set(entry.name, entry)
      at += 46 + nameLength + this.view.getUint16(at + 30, true) + this.view.getUint16(at + 32, true)
    }
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  /** A part as text; null when the archive has no such part. */
  text(name: string): string | null {
    const entry = this.entries.get(name)
    if (!entry) return null
    if (entry.flags & 1) throw new OfficeFileError('encrypted')
    if (entry.size > MAX_PART_BYTES || this.inflated + entry.size > MAX_TOTAL_BYTES) throw new OfficeFileError('too large once unpacked')
    const local = entry.offset
    if (local + 30 > this.bytes.length || this.view.getUint32(local, true) !== 0x04034b50) throw new OfficeFileError('damaged part')
    const start = local + 30 + this.view.getUint16(local + 26, true) + this.view.getUint16(local + 28, true)
    const compressed = this.bytes.subarray(start, start + entry.compressedSize)
    if (compressed.length !== entry.compressedSize) throw new OfficeFileError('truncated')
    let data: Uint8Array
    if (entry.method === 0) data = compressed
    else if (entry.method === 8) {
      try {
        // The declared size is not trusted: inflation stops at it (plus one byte, to notice a lie).
        data = inflateRawSync(compressed, { maxOutputLength: entry.size + 1 })
      } catch {
        throw new OfficeFileError('damaged part')
      }
    } else throw new OfficeFileError(`unsupported compression ${entry.method}`)
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new OfficeFileError('damaged part')
    this.inflated += data.length
    return new TextDecoder().decode(data).replace(/^﻿/, '')
  }
}

// ── XML ──────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** XML character references, decoded once (unlike HTML text, XML is never double-encoded on purpose). */
export function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (match, ref: string) => {
    if (ref[0] !== '#') return ENTITIES[ref] ?? match
    const code = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1))
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

interface Tag {
  /** Name without its namespace prefix ("w:t" → "t"). */
  name: string
  closing: boolean
  selfClosing: boolean
  attributes: string
}

/** Walks an XML part: tags and the text between them, in document order. */
function walkXml(xml: string, onTag: (tag: Tag) => void, onText: (text: string) => void) {
  const token = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<[!?][^>]*>|([^<]+)/g
  for (let match = token.exec(xml); match; match = token.exec(xml)) {
    if (match[5] !== undefined) onText(match[5])
    else if (match[2]) {
      const name = match[2].slice(match[2].indexOf(':') + 1)
      onTag({ name, closing: match[1] === '/', selfClosing: match[4] === '/', attributes: match[3] ?? '' })
    }
  }
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`).exec(attributes)
  return match ? decodeXml(match[1]!) : null
}

/** The relationship id of an element (r:id), not its own unprefixed id. */
function relationshipId(attributes: string): string {
  return /(?:^|\s)[\w-]+:id="([^"]*)"/.exec(attributes)?.[1] ?? ''
}

/** Relationship id → target part, from a .rels part, resolved against the folder of the part. */
function relationships(zip: ZipArchive, relsPath: string, baseFolder: string): Map<string, string> {
  const targets = new Map<string, string>()
  const xml = zip.text(relsPath)
  if (!xml) return targets
  walkXml(
    xml,
    (tag) => {
      if (tag.name !== 'Relationship' || tag.closing) return
      const id = attribute(tag.attributes, 'Id')
      const target = attribute(tag.attributes, 'Target')
      if (id && target && attribute(tag.attributes, 'TargetMode') !== 'External') targets.set(id, resolvePart(baseFolder, target))
    },
    () => undefined,
  )
  return targets
}

function resolvePart(folder: string, target: string): string {
  const parts = target.startsWith('/') ? [] : folder.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment && segment !== '.') parts.push(segment)
  }
  return parts.join('/')
}

// ── Word ─────────────────────────────────────────────────────────────────

/**
 * Paragraph text of a WordprocessingML part. Headings become Markdown headings and list items
 * bullets; table cells are joined with " | ", one row per line. Deleted text (tracked changes),
 * field codes and other non-text elements are left out, since only w:t runs are read.
 */
class WordReader {
  readonly lines: string[] = []
  private paragraph = ''
  private prefix = ''
  private inText = false
  private cellDepth = 0
  private row: string[] = []
  private cell = ''

  private readonly handlers: Record<string, (tag: Tag) => void> = {
    t: (tag) => {
      this.inText = !tag.closing && !tag.selfClosing
    },
    tab: (tag) => {
      if (!tag.closing) this.paragraph += '\t'
    },
    br: (tag) => this.lineBreak(tag),
    cr: (tag) => this.lineBreak(tag),
    pStyle: (tag) => {
      const style = attribute(tag.attributes, 'val') ?? ''
      const heading = /^heading\s*([1-6])$/i.exec(style)
      if (heading) this.prefix = `${'#'.repeat(Number(heading[1]))} `
      else if (/^title$/i.test(style)) this.prefix = '# '
    },
    numPr: (tag) => {
      if (!tag.closing && !this.prefix) this.prefix = '- '
    },
    p: (tag) => {
      if (tag.closing || tag.selfClosing) this.endParagraph()
    },
    tc: (tag) => {
      if (tag.closing) {
        this.cellDepth -= 1
        this.row.push(this.cell)
        this.cell = ''
      } else if (!tag.selfClosing) this.cellDepth += 1
    },
    tr: (tag) => {
      if (!tag.closing) return
      if (this.row.some(Boolean)) this.lines.push(this.row.join(' | '))
      this.row = []
    },
  }

  tag(tag: Tag) {
    this.handlers[tag.name]?.(tag)
  }

  text(text: string) {
    if (this.inText) this.paragraph += decodeXml(text)
  }

  private lineBreak(tag: Tag) {
    if (!tag.closing) this.paragraph += this.cellDepth > 0 ? ' ' : '\n'
  }

  private endParagraph() {
    const text = this.paragraph.replace(/[ \t]+/g, ' ').trim()
    if (this.cellDepth > 0) this.cell += (this.cell && text ? ' ' : '') + text
    else if (text) this.lines.push(this.prefix + text)
    this.paragraph = ''
    this.prefix = ''
  }
}

function wordText(xml: string): string {
  const reader = new WordReader()
  walkXml(
    xml,
    (tag) => reader.tag(tag),
    (text) => reader.text(text),
  )
  return reader.lines.join('\n')
}

function extractDocx(zip: ZipArchive): string {
  const parts = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']
  const main = zip.text(parts[0]!)
  if (main === null) throw new OfficeFileError('no word/document.xml')
  return [wordText(main), ...parts.slice(1).map((part) => wordText(zip.text(part) ?? ''))].filter(Boolean).join('\n\n')
}

// ── PowerPoint ───────────────────────────────────────────────────────────

/** Text of a DrawingML part (slides, notes): one line per paragraph. */
function drawingText(xml: string): string[] {
  const lines: string[] = []
  let paragraph = ''
  let inText = false
  walkXml(
    xml,
    (tag) => {
      if (tag.name === 't') inText = !tag.closing && !tag.selfClosing
      else if (tag.name === 'br' && !tag.closing) paragraph += '\n'
      else if (tag.name === 'p' && (tag.closing || tag.selfClosing)) {
        const text = paragraph.replace(/[ \t]+/g, ' ').trim()
        if (text) lines.push(text)
        paragraph = ''
      }
    },
    (text) => {
      if (inText) paragraph += decodeXml(text)
    },
  )
  return lines
}

/** Slide parts in presentation order (presentation.xml), or by number when that cannot be read. */
function slideOrder(zip: ZipArchive): string[] {
  const rels = relationships(zip, 'ppt/_rels/presentation.xml.rels', 'ppt')
  const ordered: string[] = []
  walkXml(
    zip.text('ppt/presentation.xml') ?? '',
    (tag) => {
      if (tag.name !== 'sldId' || tag.closing) return
      const target = rels.get(relationshipId(tag.attributes))
      if (target && zip.has(target)) ordered.push(target)
    },
    () => undefined,
  )
  if (ordered.length) return ordered
  const number = (name: string) => Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0)
  return zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => number(a) - number(b))
}

function extractPptx(zip: ZipArchive): string {
  const slides = slideOrder(zip)
  if (slides.length === 0) throw new OfficeFileError('no slides')
  return slides
    .map((slide, index) => {
      const folder = slide.slice(0, slide.lastIndexOf('/'))
      const fileName = slide.slice(slide.lastIndexOf('/') + 1)
      const notesPart = [...relationships(zip, `${folder}/_rels/${fileName}.rels`, folder).values()].find((target) => target.includes('notesSlide'))
      // Notes pages repeat the slide number in a placeholder: a line of digits alone is dropped.
      const notes = notesPart ? drawingText(zip.text(notesPart) ?? '').filter((line) => !/^\d+$/.test(line)) : []
      const body = drawingText(zip.text(slide) ?? '')
      return [`## Slide ${index + 1}`, ...body, ...(notes.length ? ['', `Notes: ${notes.join(' ')}`] : [])].join('\n')
    })
    .join('\n\n')
}

// ── Excel ────────────────────────────────────────────────────────────────

function sharedStrings(zip: ZipArchive): string[] {
  const strings: string[] = []
  let current = ''
  let inText = false
  let phonetic = 0
  walkXml(
    zip.text('xl/sharedStrings.xml') ?? '',
    (tag) => {
      if (tag.name === 'si') {
        if (tag.closing) strings.push(current)
        else if (tag.selfClosing) strings.push('')
        current = ''
      } else if (tag.name === 'rPh') phonetic += tag.closing ? -1 : tag.selfClosing ? 0 : 1
      else if (tag.name === 't') inText = !tag.closing && !tag.selfClosing
    },
    (text) => {
      if (inText && phonetic === 0) current += decodeXml(text)
    },
  )
  return strings
}

/** "BC12" → 54 (zero-based column index). */
function columnIndex(reference: string | null): number | null {
  const letters = /^([A-Z]+)\d*$/.exec(reference ?? '')?.[1]
  if (!letters) return null
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

/** Reads the rows of a worksheet part; stops once the shared character budget is spent. */
class SheetReader {
  readonly rows: string[][] = []
  private row: string[] = []
  private cell = { column: 0, type: '', value: '', inline: '' }
  private reading: 'v' | 't' | null = null

  constructor(
    private readonly strings: string[],
    private readonly budget: { chars: number },
  ) {}

  tag(tag: Tag) {
    if (this.budget.chars < 0) return
    const ends = tag.closing || tag.selfClosing
    if (tag.name === 'row' && ends) this.endRow()
    else if (tag.name === 'c') {
      if (!tag.closing) this.cell = { column: columnIndex(attribute(tag.attributes, 'r')) ?? this.row.length, type: attribute(tag.attributes, 't') ?? 'n', value: '', inline: '' }
      if (ends) this.endCell()
    } else if (tag.name === 'v' || tag.name === 't') this.reading = ends ? null : tag.name
  }

  text(text: string) {
    if (this.reading === 'v') this.cell.value += decodeXml(text)
    else if (this.reading === 't') this.cell.inline += decodeXml(text)
  }

  private endCell() {
    const { column, type, value, inline } = this.cell
    const shown = type === 's' ? (this.strings[Number(value)] ?? '') : type === 'inlineStr' ? inline : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE') : value
    if (column >= 16_384) return
    while (this.row.length < column) this.row.push('')
    this.row[column] = shown.replace(/\s+/g, ' ').trim()
  }

  private endRow() {
    if (this.row.some((value) => value.trim())) {
      this.rows.push(this.row)
      this.budget.chars -= this.row.reduce((total, value) => total + value.length + 3, 0)
    }
    this.row = []
  }
}

function sheetRows(xml: string, strings: string[], budget: { chars: number }): string[][] {
  const reader = new SheetReader(strings, budget)
  walkXml(
    xml,
    (tag) => reader.tag(tag),
    (text) => reader.text(text),
  )
  return reader.rows
}

function extractXlsx(zip: ZipArchive): string {
  const rels = relationships(zip, 'xl/_rels/workbook.xml.rels', 'xl')
  const sheets: Array<{ name: string; part: string }> = []
  walkXml(
    zip.text('xl/workbook.xml') ?? '',
    (tag) => {
      if (tag.name !== 'sheet' || tag.closing) return
      const part = rels.get(relationshipId(tag.attributes))
      if (part && zip.has(part)) sheets.push({ name: attribute(tag.attributes, 'name') ?? part, part })
    },
    () => undefined,
  )
  if (sheets.length === 0) throw new OfficeFileError('no worksheets')
  const strings = sharedStrings(zip)
  // Stop reading rows once the text is past what a document may hold; ingestion then reports it.
  const budget = { chars: LIMITS.documentChars }
  return sheets
    .map(({ name, part }) => {
      const table = rowsToText(sheetRows(zip.text(part) ?? '', strings, budget))
      return table ? `## Sheet: ${name}\n\n${table}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

// ── Entry point ──────────────────────────────────────────────────────────

export const OFFICE_EXTENSIONS = ['.docx', '.pptx', '.xlsx'] as const
export type OfficeExtension = (typeof OFFICE_EXTENSIONS)[number]

const KIND: Record<OfficeExtension, string> = { '.docx': 'Word document', '.pptx': 'PowerPoint presentation', '.xlsx': 'Excel workbook' }

export function isOfficeExtension(extension: string): extension is OfficeExtension {
  return (OFFICE_EXTENSIONS as readonly string[]).includes(extension)
}

/** The text of a DOCX, PPTX or XLSX file. Throws OfficeFileError with a message for the user. */
export function extractOfficeText(bytes: Uint8Array, extension: OfficeExtension, name: string): string {
  if (startsWith(bytes, OLE_MAGIC)) {
    throw new OfficeFileError(`"${name}" is password-protected or in the old binary format. Save it as a ${KIND[extension]} without a password and upload it again.`)
  }
  if (!startsWith(bytes, ZIP_MAGIC)) throw new OfficeFileError(`"${name}" is not a valid ${KIND[extension]}.`)
  try {
    const zip = new ZipArchive(bytes)
    if (extension === '.docx') return extractDocx(zip)
    if (extension === '.pptx') return extractPptx(zip)
    return extractXlsx(zip)
  } catch (error) {
    const reason = error instanceof OfficeFileError ? ` (${error.message})` : ''
    throw new OfficeFileError(`Could not read "${name}". The ${KIND[extension]} may be damaged${reason}.`)
  }
}
