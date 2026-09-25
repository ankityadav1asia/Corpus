import type { ImageAspectRatio } from '@/lib/constants'

/** Image generation, behind an interface like AiProvider so it can be swapped or faked in tests. */
export interface ImageGenerator {
  /** Model identifier recorded with every image. */
  readonly model: string
  generate(input: { prompt: string; aspectRatio: ImageAspectRatio; signal?: AbortSignal }): Promise<GeneratedImage>
}

export interface GeneratedImage {
  data: Uint8Array
  /** As reported by the model; the bytes are verified separately (server/images/inspect.ts). */
  mimeType: string
  /** Any text the model returned alongside the image. */
  text: string | null
}

/** The model refused (safety filters) — retrying the same request will not help. */
export class ImageRefusedError extends Error {
  constructor(message = 'The image model declined this request because of its safety filters. Try a different prompt or style.') {
    super(message)
    this.name = 'ImageRefusedError'
  }
}
