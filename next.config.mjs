/**
 * Security headers for every response. The Content-Security-Policy is set per request with a
 * nonce by middleware.ts (server/security/csp.ts), so it is not repeated here.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self)' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // PGlite is a devDependency used only for POSTGRES_URL=pglite:… local development (server/db/pglite.ts).
  // Tesseract (OCR) starts its own worker script and loads WebAssembly from node_modules at run time.
  serverExternalPackages: [
    'pdf-parse',
    'pdfjs-dist',
    '@napi-rs/canvas',
    'tesseract.js',
    'tesseract.js-core',
    '@tesseract.js-data/eng',
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
  ],
  // Files loaded by path at run time, which the bundler cannot see: OCR worker, engine and English data.
  outputFileTracingIncludes: {
    '/api/**/*': ['./node_modules/tesseract.js/src/**/*', './node_modules/tesseract.js-core/**/*', './node_modules/@tesseract.js-data/eng/4.0.0_best_int/**/*'],
  },
  experimental: {
    // With middleware present, Next.js buffers request bodies and silently truncates anything over
    // 10 MB by default. Uploads allow 50 MB files (lib/constants.ts → LIMITS.uploadBytes).
    middlewareClientMaxBodySize: '52mb',
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
