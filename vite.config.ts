import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Adds a strict Content-Security-Policy to the built page. `connect-src 'self'` makes it
 * impossible for any script on the page to send data to another origin.
 */
function csp(): Plugin {
  return {
    name: 'garim-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
          (m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`,
        )
        const policy = [
          "default-src 'self'",
          `script-src 'self' 'wasm-unsafe-eval' blob: ${hashes.join(' ')}`,
          "worker-src 'self' blob:",
          "connect-src 'self' blob: data:",
          "img-src 'self' blob: data:",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self' data:",
          "media-src 'self' blob: data:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join('; ')
        return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
      },
    },
  }
}

/** Generates sw.js with a precache list of the app shell (hashed assets + icons). */
function serviceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'garim-sw',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir
    },
    async closeBundle() {
      const { readFileSync, writeFileSync } = await import('node:fs')
      const files: string[] = []
      const walk = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f)
          if (statSync(p).isDirectory()) walk(p)
          else files.push(relative(outDir, p).split('\\').join('/'))
        }
      }
      walk(outDir)
      // Precache the shell only; OCR models, pdf.js resources and font subsets are cached on first use.
      const precache = files.filter(
        (f) => !f.startsWith('ocr/') && !f.startsWith('face/') && !f.startsWith('pdfjs/') && !f.startsWith('demo/') && !f.endsWith('.woff2') && !f.endsWith('.map') && f !== 'sw.js' && f !== 'og.png' && f !== '404.html' && !f.endsWith('.zip'),
      )
      const version = createHash('sha256').update(precache.join('|') + Date.now()).digest('hex').slice(0, 10)
      const template = readFileSync(join(process.cwd(), 'scripts', 'sw-template.js'), 'utf8')
      const sw = template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(['./', ...precache]))
      writeFileSync(join(outDir, 'sw.js'), sw)
    },
  }
}

/**
 * A short hash of the files that are replaced under the same name (demo videos, the extension
 * zip): appended as ?v= so browsers never show a stale copy after a deploy.
 */
function assetVersion(): string {
  const h = createHash('sha256')
  const files: string[] = []
  try {
    for (const f of readdirSync('public/demo').sort()) files.push(join('public/demo', f))
  } catch {
    /* no demos */
  }
  files.push('public/garim-extension.zip')
  for (const f of files) {
    try {
      h.update(f).update(readFileSync(f))
    } catch {
      /* missing file */
    }
  }
  return h.digest('hex').slice(0, 10)
}

export default defineConfig({
  base: './',
  plugins: [react(), csp(), serviceWorker()],
  define: { __ASSET_VERSION__: JSON.stringify(assetVersion()) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react')) return 'react'
          if (id.includes('node_modules/pdfjs-dist')) return 'pdfjs'
          if (id.includes('node_modules/jszip')) return 'jszip'
        },
      },
    },
  },
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0])
