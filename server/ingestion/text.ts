import * as cheerio from 'cheerio'

import { LIMITS } from '@/lib/constants'

/** Cleans extracted text. Postgres `text` cannot store NUL bytes, which PDFs often contain. */
export function normalizeExtractedText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function truncateTitle(title: string, max: number = LIMITS.documentTitleChars): string {
  const flat = title.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const NON_CONTENT = 'script, style, noscript, template, svg, iframe, canvas, form, nav, footer, header, aside, [role="navigation"], [role="banner"], [aria-hidden="true"]'
const BLOCK_ELEMENTS = 'p, div, section, article, main, li, h1, h2, h3, h4, h5, h6, tr, pre, blockquote, table, ul, ol'

export function htmlToDocument(html: string, fallbackTitle: string): { title: string; text: string } {
  const $ = cheerio.load(html)
  const title = $('title').first().text().trim() || $('h1').first().text().trim() || fallbackTitle
  $(NON_CONTENT).remove()
  $('br').replaceWith('\n')
  $(BLOCK_ELEMENTS).each((_, element) => {
    $(element).append('\n')
  })
  const main = $('main, article, [role="main"]').first()
  let text = (main.length ? main : $('body')).text()
  if (main.length && text.trim().length < 200) text = $('body').text()
  return { title: truncateTitle(title) || truncateTitle(fallbackTitle), text: normalizeExtractedText(text) }
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, delimiters and newlines inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''))
}

/** Tables become one "column: value" line per row so each chunk is self-describing. */
export function delimitedToText(text: string, delimiter: string): string {
  const rows = parseDelimited(text.replace(/^﻿/, ''), delimiter)
  const [header, ...body] = rows
  if (!header) return ''
  const columns = header.map((name, index) => name.trim() || `column_${index + 1}`)
  if (body.length === 0) return columns.join(', ')
  const lines = body.map((cells, index) => `Row ${index + 1}: ${columns.map((column, i) => `${column}: ${(cells[i] ?? '').trim()}`).join(' | ')}`)
  return `Table columns: ${columns.join(', ')}\n\n${lines.join('\n')}`
}

function fromCodePoint(code: number, original: string) {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original
}

export function decodeHtmlEntities(value: string): string {
  let current = value
  // Transcripts are sometimes double-encoded (&amp;#39;), so decode until stable (max 3 passes).
  for (let pass = 0; pass < 3; pass++) {
    const next = current
      .replace(/&#(\d+);/g, (match, code: string) => fromCodePoint(Number(code), match))
      .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => fromCodePoint(Number.parseInt(code, 16), match))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
    if (next === current) break
    current = next
  }
  return current
}
