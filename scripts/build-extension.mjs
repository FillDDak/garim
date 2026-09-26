// Builds the browser extension (content script + popup) and packs it as public/garim-extension.zip
import { build } from 'vite'
import { cpSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import JSZip from 'jszip'
import { chromium } from 'playwright'

const root = new URL('..', import.meta.url).pathname
const out = join(root, 'extension', 'dist')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

for (const entry of ['content', 'popup']) {
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: out,
      emptyOutDir: false,
      target: 'chrome110',
      minify: true,
      lib: { entry: join(root, 'extension', 'src', `${entry}.ts`), formats: ['iife'], name: `garim_${entry}`, fileName: () => `${entry}.js` },
    },
  })
}
cpSync(join(root, 'extension', 'static'), out, { recursive: true })

// icons from the favicon
mkdirSync(join(out, 'icons'), { recursive: true })
const svg = readFileSync(join(root, 'public', 'favicon.svg'), 'utf8')
let browser
try {
  browser = await chromium.launch()
  const page = await browser.newPage()
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`)
    await page.screenshot({ path: join(out, 'icons', `${size}.png`), omitBackground: true })
  }
} catch {
  // CI without a browser: fall back to the committed PNG icons
  for (const size of [16, 32, 48, 128]) cpSync(join(root, 'public', 'icons', 'icon-192.png'), join(out, 'icons', `${size}.png`))
} finally {
  await browser?.close()
}

const zip = new JSZip()
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p)
    else zip.file(relative(out, p), readFileSync(p))
  }
}
walk(out)
writeFileSync(join(root, 'public', 'garim-extension.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
console.log('extension built → public/garim-extension.zip')
