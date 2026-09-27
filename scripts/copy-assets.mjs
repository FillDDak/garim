// Copies the Tesseract OCR engine + Korean/English models into public/ocr so the
// app can run OCR fully offline without any third-party CDN.
import { copyFileSync, cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = join(root, 'node_modules')
const out = join(root, 'public', 'ocr')
mkdirSync(join(out, 'core'), { recursive: true })
mkdirSync(join(out, 'lang'), { recursive: true })
mkdirSync(join(root, 'public', 'face'), { recursive: true })

const files = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'core/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['@tesseract.js-data/kor/4.0.0_best_int/kor.traineddata.gz', 'lang/kor.traineddata.gz'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'lang/eng.traineddata.gz'],
  // face detector for ID photos / selfies
  ['@vladmandic/face-api/model/ssd_mobilenetv1_model-weights_manifest.json', '../face/ssd_mobilenetv1_model-weights_manifest.json'],
  ['@vladmandic/face-api/model/ssd_mobilenetv1_model.bin', '../face/ssd_mobilenetv1_model.bin'],
]

// pdf.js resources (Korean PDFs need the CMaps to extract text)
const pdfOut = join(root, 'public', 'pdfjs')
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  const src = join(nm, 'pdfjs-dist', dir)
  if (existsSync(src)) cpSync(src, join(pdfOut, dir), { recursive: true })
}

for (const [from, to] of files) {
  const src = join(nm, from)
  const dst = join(out, to)
  if (!existsSync(src)) throw new Error(`missing ${src} — run npm install`)
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue
  copyFileSync(src, dst)
}
console.log('OCR, face and PDF assets ready in public/ocr, public/face, public/pdfjs')
