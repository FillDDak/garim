// Renders PNG icons + the social preview image from SVG/HTML using the local Chromium.
// Usage: node scripts/gen-icons.mjs   (requires the `playwright` package)
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const svg = readFileSync('public/favicon.svg', 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage()

async function shot(html, w, h, path) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden">${html}</body></html>`)
  await page.waitForTimeout(150)
  await page.screenshot({ path, omitBackground: true })
}

const icon = (size, pad = 0, bg = 'transparent') =>
  `<div style="width:${size}px;height:${size}px;display:grid;place-items:center;background:${bg}"><div style="width:${size - pad * 2}px;height:${size - pad * 2}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></div>`

await shot(icon(192), 192, 192, 'public/icons/icon-192.png')
await shot(icon(512), 512, 512, 'public/icons/icon-512.png')
await shot(icon(180, 0, '#5a3ff5'), 180, 180, 'public/icons/apple-touch-icon.png')
// maskable: full-bleed background with the mark inside the safe zone
const mask = svg.replace(/<rect x="2" y="2"[^>]*\/>/, '').replace('viewBox="0 0 64 64"', 'viewBox="-12 -12 88 88"')
await shot(`<div style="width:512px;height:512px;background:linear-gradient(135deg,#7b5cff,#3f2bd6)">${mask.replace('<svg ', '<svg width="100%" height="100%" ')}</div>`, 512, 512, 'public/icons/maskable-512.png')

await browser.close()
console.log('icons written')
