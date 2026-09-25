import os from 'node:os'
import path from 'node:path'

import type { VisionModel } from '@/server/ai/media'

/**
 * OCR for scanned PDF pages and images.
 *   tesseract — Tesseract (open source, runs in-process via WebAssembly; no API calls, no quota).
 *               English language data ships with the app (@tesseract.js-data/eng), so it works offline;
 *               other OCR_LANGUAGES are downloaded once by tesseract.js and cached.
 *   vision    — the configured vision model (better on handwriting and complex layouts; costs requests).
 */

export interface OcrResult {
  text: string
  /** 0–100 where the engine reports one. */
  confidence: number | null
}

export interface OcrEngine {
  readonly name: string
  recognize(input: { data: Uint8Array; mimeType: string; signal?: AbortSignal }): Promise<OcrResult>
  /** Frees the engine (the Tesseract worker); safe to call more than once. */
  close(): Promise<void>
}

const BUNDLED_ENGLISH = path.join(process.cwd(), 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int')

interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>
  terminate(): Promise<unknown>
}

export function createTesseractOcr(options: { languages: string }): OcrEngine {
  let worker: Promise<TesseractWorker> | null = null

  async function getWorker(): Promise<TesseractWorker> {
    worker ??= (async () => {
      const { createWorker, OEM } = await import('tesseract.js')
      const englishOnly = options.languages === 'eng'
      return (await createWorker(options.languages, OEM.LSTM_ONLY, {
        ...(englishOnly ? { langPath: BUNDLED_ENGLISH, gzip: true, cacheMethod: 'none' } : { cachePath: path.join(os.tmpdir(), 'corpus-tessdata') }),
      })) as unknown as TesseractWorker
    })()
    return worker
  }

  return {
    name: `tesseract:${options.languages}`,
    async recognize({ data: image }) {
      const { data } = await (await getWorker()).recognize(Buffer.from(image))
      return { text: data.text.trim(), confidence: Number.isFinite(data.confidence) ? data.confidence : null }
    },
    async close() {
      const current = worker
      worker = null
      if (current) await (await current).terminate().catch(() => undefined)
    },
  }
}

export function createVisionOcr(vision: VisionModel): OcrEngine {
  return {
    name: `vision:${vision.model}`,
    async recognize({ data, mimeType, signal }) {
      return { text: await vision.readImage({ data, mimeType, mode: 'ocr', signal }), confidence: null }
    },
    async close() {},
  }
}
