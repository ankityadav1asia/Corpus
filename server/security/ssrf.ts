import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import zlib from 'node:zlib'

import { AppError, Errors } from '@/server/http/errors'

/**
 * Server-side fetching of user-supplied URLs without SSRF.
 *
 * The previous `fetch(url)` let anyone read cloud metadata (169.254.169.254), localhost
 * services and the private network, then read the response back through the chunk explorer.
 * Here every DNS answer is checked *at connection time* (which also defeats DNS rebinding),
 * every redirect hop is re-validated, and body size / time are capped.
 */

// Separate lists on purpose: Node's BlockList also matches IPv4 addresses against IPv4-mapped
// IPv6 rules, so a single list containing ::ffff:0:0/96 would block every IPv4 address.
const blockedV4 = new BlockList()
const blockedV6 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedV4.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23], // incl. Teredo
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['fec0::', 10],
  ['ff00::', 8], // multicast
] as const) {
  blockedV6.addSubnet(network, prefix, 'ipv6')
}

export function isPublicIp(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blockedV4.check(address, 'ipv4')
  if (family === 6) return !blockedV6.check(address, 'ipv6')
  return false
}

export type AddressPolicy = (address: string) => boolean

export const STANDARD_PORTS: ReadonlySet<string> = new Set(['', '80', '443', '8080', '8443'])

/** Syntactic checks that do not need DNS. */
export function parseFetchableUrl(raw: string, policy: AddressPolicy = isPublicIp, allowedPorts: ReadonlySet<string> = STANDARD_PORTS): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw Errors.badRequest('Enter a valid http(s) URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Errors.badRequest('Only http and https URLs are supported.')
  if (url.username || url.password) throw Errors.badRequest('URLs with embedded credentials are not allowed.')
  if (!allowedPorts.has(url.port)) throw Errors.badRequest('Only standard web ports (80, 443, 8080, 8443) are allowed.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw Errors.badRequest('The URL has no host.')
  if (isIP(host) && !policy(host)) throw blockedTarget()
  return url
}

function blockedTarget() {
  return Errors.badRequest('That address points to a private or reserved network and cannot be fetched.')
}

class BlockedAddressError extends Error {
  constructor() {
    super('Blocked address')
    this.name = 'BlockedAddressError'
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

/** Drop-in for `dns.lookup` used by http(s).request: rejects if ANY resolved address is non-public. */
function guardedLookup(policy: AddressPolicy) {
  return (hostname: string, options: { all?: boolean; family?: number | string }, callback: LookupCallback) => {
    dnsLookup(hostname, { all: true, family: typeof options.family === 'number' ? options.family : 0 }, (error, addresses) => {
      if (error) return callback(error, [])
      if (addresses.length === 0 || addresses.some((entry) => !policy(entry.address))) {
        return callback(new BlockedAddressError() as NodeJS.ErrnoException, [])
      }
      if (options.all) return callback(null, addresses)
      const first = addresses[0]!
      return callback(null, first.address, first.family)
    })
  }
}

export interface FetchedPage {
  url: string
  contentType: string
  body: string
}

export interface SafeFetchOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  acceptContentTypes?: readonly string[]
  /** Tests inject a permissive policy / port list to exercise redirects and limits against a local server. */
  addressPolicy?: AddressPolicy
  allowedPorts?: ReadonlySet<string>
}

const DEFAULTS = {
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 3,
  acceptContentTypes: ['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown'],
}

export async function safeFetchText(rawUrl: string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const policy = options.addressPolicy ?? isPublicIp
  const ports = options.allowedPorts ?? STANDARD_PORTS
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects
  const accept = options.acceptContentTypes ?? DEFAULTS.acceptContentTypes
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULTS.timeoutMs)

  let current = parseFetchableUrl(rawUrl, policy, ports)
  for (let hop = 0; ; hop++) {
    const response = await request(current, policy, signal)
    const status = response.statusCode ?? 0

    if ([301, 302, 303, 307, 308].includes(status)) {
      response.resume()
      const location = response.headers.location
      if (!location) throw Errors.upstream('The site sent a redirect without a location.')
      if (hop >= maxRedirects) throw Errors.upstream('Too many redirects.')
      current = parseFetchableUrl(new URL(location, current).toString(), policy, ports)
      continue
    }
    if (status < 200 || status >= 300) {
      response.resume()
      throw Errors.upstream(`The site responded with HTTP ${status}.`)
    }

    const contentType = String(response.headers['content-type'] ?? 'text/html').toLowerCase()
    const mime = contentType.split(';')[0]!.trim()
    if (!accept.includes(mime)) {
      response.resume()
      throw Errors.unsupportedMediaType(`Unsupported content type "${mime}". Only web pages and plain text can be imported.`)
    }

    const bytes = await readCapped(response, maxBytes)
    return { url: current.toString(), contentType, body: decode(bytes, contentType) }
  }
}

function request(url: URL, policy: AddressPolicy, signal: AbortSignal): Promise<IncomingMessage> {
  const client = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup(policy) as unknown as typeof dnsLookup,
        signal,
        headers: {
          'User-Agent': 'CorpusBot/1.0 (+knowledge-base importer)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      resolve,
    )
    req.on('error', (error) => reject(mapNetworkError(error)))
    req.end()
  })
}

function mapNetworkError(error: unknown): AppError {
  if (error instanceof BlockedAddressError || (error as { cause?: unknown })?.cause instanceof BlockedAddressError) {
    return blockedTarget()
  }
  const name = (error as { name?: string })?.name
  if (name === 'AbortError' || name === 'TimeoutError') return Errors.upstream('The site took too long to respond.')
  return Errors.upstream('Could not reach that URL.')
}

async function readCapped(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase()
  let stream: NodeJS.ReadableStream = response
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(zlib.createGunzip())
  else if (encoding === 'deflate') stream = response.pipe(zlib.createInflate())
  else if (encoding === 'br') stream = response.pipe(zlib.createBrotliDecompress())

  const chunks: Buffer[] = []
  let total = 0
  try {
    // The cap applies to *decompressed* bytes, so compression bombs are stopped too.
    for await (const chunk of stream) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
      total += buffer.length
      if (total > maxBytes) {
        response.destroy()
        throw Errors.payloadTooLarge(`The page is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`)
      }
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw mapNetworkError(error)
  }
  return Buffer.concat(chunks)
}

function decode(bytes: Buffer, contentType: string): string {
  const charset = /charset=([^;]+)/i
    .exec(contentType)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}
