/** Draws a messenger-style screenshot with fictional personal data for the OCR demo. */
export async function makeSampleImage(): Promise<File> {
  const W = 720
  const H = 900
  const s = 2 // render at 2x like a phone screenshot
  const c = document.createElement('canvas')
  c.width = W * s
  c.height = H * s
  const ctx = c.getContext('2d')!
  ctx.scale(s, s)
  try {
    await document.fonts.load('600 18px "Pretendard Variable"', '가나다라마바사')
  } catch {
    /* use fallback font */
  }
  const font = (w: number, size: number) => `${w} ${size}px "Pretendard Variable", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`

  ctx.fillStyle = '#b2c7d9'
  ctx.fillRect(0, 0, W, H)
  // top bar
  ctx.fillStyle = '#a4b8ca'
  ctx.fillRect(0, 0, W, 64)
  ctx.fillStyle = '#1b1b1b'
  ctx.font = font(700, 20)
  ctx.fillText('부동산 계약 단톡방', 24, 40)

  const bubble = (x: number, y: number, lines: string[], mine: boolean) => {
    ctx.font = font(500, 19)
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 32
    const h = lines.length * 30 + 20
    const bx = mine ? W - w - x : x
    ctx.fillStyle = mine ? '#fee500' : '#ffffff'
    ctx.beginPath()
    ctx.roundRect(bx, y, w, h, 14)
    ctx.fill()
    ctx.fillStyle = '#111'
    lines.forEach((l, i) => ctx.fillText(l, bx + 16, y + 34 + i * 30))
    return y + h + 18
  }
  const name = (x: number, y: number, n: string) => {
    ctx.fillStyle = '#39424c'
    ctx.font = font(600, 15)
    ctx.fillText(n, x, y)
  }

  let y = 92
  name(84, y, '박지훈 공인중개사')
  ctx.fillStyle = '#7d93ab'
  ctx.beginPath()
  ctx.roundRect(20, y - 14, 50, 50, 18)
  ctx.fill()
  y = bubble(84, y + 10, ['안녕하세요, 계약서 작성을 위해', '임차인분 정보 한 번 더 확인 부탁드려요.'], false)
  y = bubble(24, y, ['성명: 최유진', '연락처: 010-2345-6789', '주민번호: 920815-2123456'], true)
  y = bubble(24, y, ['주소는 서울특별시 송파구 올림픽로 300,', '롯데캐슬 102동 1504호 입니다.'], true)
  name(84, y + 8, '박지훈 공인중개사')
  ctx.fillStyle = '#7d93ab'
  ctx.beginPath()
  ctx.roundRect(20, y - 6, 50, 50, 18)
  ctx.fill()
  y = bubble(84, y + 18, ['감사합니다. 계약금은 아래 계좌로', '입금해 주세요.', '국민은행 123456-01-987654 (예금주 김서준)'], false)
  bubble(24, y, ['네 오늘 오후에 보내드릴게요!'], true)

  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'))
  return new File([blob], '예시_단톡방_캡처.png', { type: 'image/png' })
}
