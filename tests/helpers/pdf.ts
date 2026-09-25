import { deflateSync } from 'node:zlib'

import { createCanvas } from '@napi-rs/canvas'

/**
 * Builds small PDFs for tests: pages are either real text (a text layer) or a scanned image of text
 * (no text layer at all), so the OCR path can be exercised end to end without fixture files.
 */

export type PdfPage = { text: string[] } | { scanned: string[] }

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

function scannedImage(lines: string[]): { width: number; height: number; data: Buffer } {
  const width = 1224
  const height = 400
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#000000'
  context.font = '40px sans-serif'
  lines.forEach((line, index) => context.fillText(line, 40, 80 + index * 70))
  const rgba = context.getImageData(0, 0, width, height).data
  const gray = Buffer.alloc(width * height)
  for (let i = 0; i < gray.length; i++) gray[i] = rgba[i * 4]!
  return { width, height, data: deflateSync(gray) }
}

const escapePdfText = (text: string) => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

export function makePdf(pages: PdfPage[]): Uint8Array {
  const objects: Buffer[] = []
  const add = (body: Buffer | string) => {
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body)
    return objects.length
  }
  const stream = (dictionary: string, data: Buffer) =>
    Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')])

  const catalog = add('') // placeholders, filled once the page ids are known
  const pagesId = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pageIds: number[] = []
  for (const page of pages) {
    if ('text' in page) {
      const content = `BT /F1 18 Tf 72 720 Td 24 TL ${page.text.map((line) => `(${escapePdfText(line)}) Tj T*`).join(' ')} ET`
      const contents = add(stream('', Buffer.from(content, 'latin1')))
      pageIds.push(
        add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents} 0 R >>`),
      )
    } else {
      const image = scannedImage(page.scanned)
      const imageId = add(
        stream(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, image.data),
      )
      const drawHeight = Math.round((PAGE_WIDTH * image.height) / image.width)
      const contents = add(stream('', Buffer.from(`q ${PAGE_WIDTH} 0 0 ${drawHeight} 0 ${PAGE_HEIGHT - drawHeight} cm /Im0 Do Q`, 'latin1')))
      pageIds.push(
        add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contents} 0 R >>`),
      )
    }
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'latin1')
  objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'latin1')

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets: number[] = []
  let length = chunks[0]!.length
  objects.forEach((body, index) => {
    offsets.push(length)
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')])
    chunks.push(chunk)
    length += chunk.length
  })
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('')
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'))
  return new Uint8Array(Buffer.concat(chunks))
}
