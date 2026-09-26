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

// Social preview (1200x630)
{
  const b = await chromium.launch()
  const p = await b.newPage({ viewport: { width: 1200, height: 630 } })
  await p.setContent(`<html><head><style>
  body{margin:0;width:1200px;height:630px;font-family:'Pretendard Variable','Noto Sans CJK KR','Noto Sans KR',sans-serif;background:#0c0d12;color:#fff;overflow:hidden;position:relative}
  .bg{position:absolute;inset:0;background:radial-gradient(700px 400px at 0% 0%,rgba(123,92,255,.45),transparent 60%),radial-gradient(600px 400px at 100% 100%,rgba(16,140,220,.3),transparent 60%)}
  .wrap{position:relative;padding:70px 80px}
  .brand{display:flex;align-items:center;gap:18px;font-size:40px;font-weight:800}
  h1{font-size:64px;line-height:1.2;margin:48px 0 26px;letter-spacing:-2px;font-weight:800}
  .g{background:linear-gradient(95deg,#a797ff,#f07ad8 60%,#ff9a7a);-webkit-background-clip:text;color:transparent}
  .row{display:flex;gap:14px;font-size:30px;align-items:center;color:#c3c7d3}
  .chip{background:rgba(255,94,145,.18);color:#ff9dbb;padding:4px 14px;border-radius:12px;font-weight:700}
  .chip2{background:rgba(60,170,255,.18);color:#8fd0ff;padding:4px 14px;border-radius:12px;font-weight:700}
  .foot{position:absolute;left:80px;bottom:60px;font-size:26px;color:#9097a8}
  </style></head><body><div class="bg"></div><div class="wrap">
  <div class="brand"><div style="width:72px;height:72px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div>가림</div>
  <h1>AI에 붙여넣기 전,<br/><span class="g">개인정보는 가리고 답변은 되돌리고</span></h1>
  <div class="row">김민수 010-1234-5678 → <span class="chip">[이름_1]</span><span class="chip2">[전화_1]</span></div>
  </div><div class="foot">서버 전송 0 · 완전 오프라인 · 문서 · PDF · 캡처 이미지까지</div></body></html>`)
  await p.waitForTimeout(300)
  await p.screenshot({ path: 'public/og.png' })
  await b.close()
  console.log('og image written')
}
