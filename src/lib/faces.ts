import { assetUrl } from './assetUrl'
import type { Detection } from './ocr'

type FaceApi = typeof import('@vladmandic/face-api')

let apiPromise: Promise<FaceApi> | null = null

/** Loads the face detector (TensorFlow.js + SSD MobileNet, served from this site) once. */
function loadFaceApi(): Promise<FaceApi> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const faceapi = await import('@vladmandic/face-api')
      // the bundled tfjs typings omit the backend helpers
      const tf = faceapi.tf as unknown as { setBackend(name: string): Promise<boolean>; ready(): Promise<void> }
      const ok = await tf.setBackend('webgl').catch(() => false)
      if (!ok) await tf.setBackend('cpu')
      await tf.ready()
      await faceapi.nets.ssdMobilenetv1.loadFromUri(assetUrl('face'))
      return faceapi
    })().catch((err) => {
      apiPromise = null
      throw err
    })
  }
  return apiPromise
}

/**
 * Finds faces (ID photos, selfies, people in screenshots). The box is enlarged to cover hair and
 * chin, which identify a person as much as the face itself.
 */
export async function detectFaces(canvas: HTMLCanvasElement, rotate = 0): Promise<Detection[]> {
  try {
    const faceapi = await loadFaceApi()
    const find = async (c: HTMLCanvasElement, minConfidence: number) =>
      (await faceapi.detectAllFaces(c, new faceapi.SsdMobilenetv1Options({ minConfidence, maxResults: 30 }))).map((r) => {
        const b = r.box
        const padX = b.width * 0.3
        const padTop = b.height * 0.45
        const padBottom = b.height * 0.4
        return { score: r.score, x0: b.x - padX, y0: b.y - padTop, x1: b.x + b.width + padX, y1: b.y + b.height + padBottom }
      })
    // the detector only finds upright faces: a sideways / upside-down photo (orientation found by
    // OCR) is turned upright first
    let found: Awaited<ReturnType<typeof find>>
    let toSource: ((x: number, y: number) => [number, number]) | null = null
    if (rotate) {
      const { rotateCanvas } = await import('./deskew')
      const r = rotateCanvas(canvas, rotate)
      found = await find(r.canvas, 0.35)
      r.canvas.width = r.canvas.height = 0
      toSource = r.toSource
    } else found = await find(canvas, 0.35)
    return found.map((f, i) => {
      let { x0, y0, x1, y1 } = f
      if (toSource) {
        const pts = [toSource(x0, y0), toSource(x1, y0), toSource(x1, y1), toSource(x0, y1)]
        x0 = Math.min(...pts.map((p) => p[0]))
        x1 = Math.max(...pts.map((p) => p[0]))
        y0 = Math.min(...pts.map((p) => p[1]))
        y1 = Math.max(...pts.map((p) => p[1]))
      }
      const x = Math.max(0, x0)
      const y = Math.max(0, y0)
      return {
        id: `face:${i}:${Math.round(x)}:${Math.round(y)}`,
        type: 'face' as const,
        text: `얼굴 (${Math.round(f.score * 100)}%)`,
        box: { x, y, w: Math.min(canvas.width, x1) - x, h: Math.min(canvas.height, y1) - y },
      }
    })
  } catch (err) {
    console.warn('face detection unavailable', err)
    return []
  }
}
