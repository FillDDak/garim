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
export async function detectFaces(canvas: HTMLCanvasElement): Promise<Detection[]> {
  try {
    const faceapi = await loadFaceApi()
    const results = await faceapi.detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35, maxResults: 30 }))
    return results.map((r, i) => {
      const b = r.box
      const padX = b.width * 0.3
      const padTop = b.height * 0.45
      const padBottom = b.height * 0.4
      const x = Math.max(0, b.x - padX)
      const y = Math.max(0, b.y - padTop)
      const w = Math.min(canvas.width - x, b.width + padX * 2)
      const h = Math.min(canvas.height - y, b.height + padTop + padBottom)
      return {
        id: `face:${i}:${Math.round(b.x)}:${Math.round(b.y)}`,
        type: 'face' as const,
        text: `얼굴 (${Math.round(r.score * 100)}%)`,
        box: { x, y, w, h },
      }
    })
  } catch (err) {
    console.warn('face detection unavailable', err)
    return []
  }
}
