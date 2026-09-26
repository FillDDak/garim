import { expect, it } from 'vitest'
import { detect, defaultDetectOptions } from '../src/core/engine'
import { applyMask } from '../src/core/mask'
import { SAMPLE_TEXT } from '../src/lib/samples'

it('handles ~200KB of text quickly', () => {
  const big = Array.from({ length: 400 }, () => SAMPLE_TEXT).join('\n\n')
  const t0 = performance.now()
  const ents = detect(big, { ...defaultDetectOptions(), strongNames: true })
  const r = applyMask(big, ents, new Set(), { mode: 'token', tokenLang: 'ko', partialRedact: true })
  const ms = performance.now() - t0
  console.log(big.length, 'chars', ents.length, 'entities', ms.toFixed(0), 'ms')
  expect(r.mapping.length).toBeLessThan(40)
  expect(ms).toBeLessThan(3000)
})
