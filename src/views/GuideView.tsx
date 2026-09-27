import { Bot, ClipboardCheck, Copy, Puzzle, FileLock2, ImageOff, KeyRound, Lock, PlaneTakeoff, ScanSearch, Undo2, WifiOff } from 'lucide-react'
import { Card, Segmented } from '../components/ui'
import { GithubMark } from '../components/Logo'
import { useApp } from '../state/AppState'
import { copyText } from '../lib/clipboard'
import { useState } from 'react'
import { FEEDBACK_EMAIL, FEEDBACK_MAILTO } from '../lib/feedback'

const REPO = 'https://github.com/FillDDak/what'

const FAQ: Array<[string, React.ReactNode]> = [
  [
    '정말 서버로 아무것도 안 보내나요?',
    <>
      네. 가림은 서버가 없는 정적 웹페이지이고, 페이지에 <b>외부 전송을 막는 보안 정책(CSP)</b>이 걸려 있어 자바스크립트가 다른 주소로 데이터를 보낼 수 없어요.
      직접 확인하려면 페이지를 연 뒤 <b>인터넷을 끄고</b> 써 보세요. 모든 기능이 그대로 동작합니다.
    </>,
  ],
  [
    '자리표시자로 바꾸면 AI 답변 품질이 떨어지지 않나요?',
    <>
      대부분의 업무(메일 작성, 요약, 번역, 표 정리, 코드 디버깅)에는 실제 이름·번호가 필요 없어요. 같은 사람은 항상 같은 표시([이름_1])로 바뀌기 때문에 AI가 관계를 그대로 이해합니다.
      문장이 자연스러워야 한다면 ‘가짜 값’ 방식을 쓰세요.
    </>,
  ],
  [
    'AI가 [이름_1]을 [이름 1]이나 【이름_1】로 바꿔 쓰면요?',
    <>괄호 모양, 띄어쓰기, 밑줄 유무가 달라져도 찾아서 되돌립니다. 가짜 전화번호는 하이픈이 빠져도 복원돼요. 세션에 없는 표시는 노란색으로 알려 드려요.</>,
  ],
  [
    '100% 다 찾아 주나요?',
    <>
      아니요. 주민번호·카드번호·사업자번호처럼 규칙이 있는 정보는 검증 알고리즘으로 정확히 찾지만, 이름·주소는 문맥으로 추정해요. <b>보내기 전에 결과를 한 번 훑어보고</b>, 빠진 부분은 드래그해서 가리거나 ‘내
      사전’에 등록하세요.
    </>,
  ],
  [
    '복원 키는 어디에 저장되나요?',
    <>이 브라우저의 저장소(localStorage)에만 저장되고, 기본 24시간 뒤 자동으로 지워져요. 설정에서 ‘저장 안 함’부터 ‘직접 지울 때까지’까지 고를 수 있어요.</>,
  ],
  [
    '오류나 사용 기록을 수집하나요?',
    <>
      아니요. 웹사이트와 확장 프로그램 모두 오류 보고·사용 통계·광고 추적 코드가 없고, 어떤 정보도 밖으로 보내지 않아요. 크롬 확장 프로그램 관리 화면의 <b>‘오류 수집’</b> 스위치는 크롬 자체 기능으로, 켜
      두면 확장 프로그램에서 난 오류를 <b>내 브라우저의 오류 목록에만</b> 기록해 보여 줘요. 가림 개발자에게 전송되지 않아요.
    </>,
  ],
  [
    '건의 사항이나 오류는 어디로 알려 주나요?',
    <>
      필요한 기능, 불편한 점, 잘못 가려지거나 놓친 개인정보가 있다면{' '}
      <a href={FEEDBACK_MAILTO}>{FEEDBACK_EMAIL}</a>로 알려 주세요. 어떤 화면에서 무엇을 했는지 적어 주시면 더 빨리 고칠 수 있어요. 예시를 보내실 때는{' '}
      <b>실제 개인정보를 지우거나 가짜 값으로 바꿔서</b> 보내 주세요.
    </>,
  ],
  [
    '회사에서 써도 되나요?',
    <>
      네. 설치나 로그인이 필요 없고, 한 번 열면 오프라인에서도 동작하도록 앱으로 설치(PWA)할 수 있어요. 소스 코드는{' '}
      <a href={REPO} target="_blank" rel="noreferrer">
        GitHub
      </a>
      에 공개되어 있어 보안팀이 직접 검토할 수 있습니다.
    </>,
  ],
]

const EXT_PAGES = [
  { name: '크롬', url: 'chrome://extensions', ua: null },
  { name: '엣지', url: 'edge://extensions', ua: /Edg\// },
  { name: '웨일', url: 'whale://extensions', ua: /Whale\// },
] as const

/** The extensions page of the browser this page is open in. */
function currentBrowserUrl(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return EXT_PAGES.find((p) => p.ua?.test(ua))?.url ?? 'chrome://extensions'
}

/**
 * Browsers refuse to open chrome:// / edge:// / whale:// pages from a web link, so a click copies
 * the address for the address bar instead.
 */
function ExtPageLink({ name, url, current }: { name: string; url: string; current: boolean }) {
  const { toast } = useApp()
  return (
    <a
      href={url}
      className={`ext-page-link ${current ? 'current' : ''}`}
      title="클릭하면 주소가 복사돼요"
      onClick={async (e) => {
        e.preventDefault()
        const ok = await copyText(url)
        toast(ok ? `${url} 주소를 복사했어요. 새 탭 주소창에 붙여넣고 Enter를 누르세요` : `${url} 을 주소창에 직접 입력해 주세요`, ok ? 'success' : 'warn')
      }}
    >
      {name} <code>{url}</code>
      <Copy size={12} aria-hidden="true" />
      {current && <span className="ext-page-now">지금 브라우저</span>}
    </a>
  )
}

type DemoId = 'text' | 'image' | 'extension'
const DEMOS: Array<{ value: DemoId; label: string; alt: string; w: number; h: number }> = [
  { value: 'text', label: '텍스트 가리기·되돌리기', alt: '글을 붙여넣으면 개인정보가 자리표시자로 가려지고, AI 답변을 붙여넣으면 원래 값으로 돌아오는 화면', w: 1180, h: 700 },
  { value: 'image', label: '이미지 가리기', alt: '카톡 캡처 이미지에서 글자를 인식해 개인정보를 박스로 가리는 화면', w: 1180, h: 700 },
  { value: 'extension', label: '브라우저 확장', alt: 'AI 채팅창에 붙여넣는 순간 개인정보가 가려지고, 답변에서는 내 화면에만 원래 값이 보이는 화면', w: 1000, h: 640 },
]

/** WebM (VP9) is sharp and small; browsers that can't play it get the GIF. */
const canPlayWebm = () => typeof document !== 'undefined' && document.createElement('video').canPlayType('video/webm; codecs="vp9"') !== ''

/** One demo at a time, so the guide stays light to load. */
function DemoViewer() {
  const [demo, setDemo] = useState<DemoId>('text')
  const [video] = useState(canPlayWebm)
  const d = DEMOS.find((x) => x.value === demo)!
  return (
    <section className="demo">
      <h2>이렇게 동작해요</h2>
      <Segmented<DemoId> label="예시 선택" value={demo} options={DEMOS.map(({ value, label }) => ({ value, label }))} onChange={setDemo} size="sm" />
      <Card className="demo-card">
        {video ? (
          <video key={d.value} src={`demo/${d.value}.webm`} poster={`demo/${d.value}.jpg`} width={d.w} height={d.h} autoPlay muted loop playsInline preload="auto" aria-label={d.alt} />
        ) : (
          <img key={d.value} src={`demo/${d.value}.gif`} alt={d.alt} width={d.w} height={d.h} loading="lazy" decoding="async" />
        )}
      </Card>
      <p className="muted demo-note">예시 속 이름·번호는 모두 지어낸 값이에요.</p>
    </section>
  )
}

export function GuideView({ go }: { go: (route: string) => void }) {
  return (
    <div className="view guide-view">
      <section className="guide-hero">
        <p className="eyebrow">AI 시대의 개인정보 가림막</p>
        <h1>
          ChatGPT에 붙여넣기 전에,
          <br />
          <span className="grad">가림</span>을 한 번 거치세요.
        </h1>
        <p className="lead">
          업무 메일, 고객 문의, 계약서, 에러 로그를 AI에게 보여줄 때마다 이름·주민번호·전화번호·계좌번호·API 키가 함께 넘어갑니다. 가림은 이런 정보를 <b>내 기기 안에서</b> 찾아 가리고, AI의 답변은
          다시 <b>원래 값으로 되돌려</b> 줍니다.
        </p>
        <div className="hero-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => go('text')}>
            지금 바로 써 보기
          </button>
          <a className="btn btn-secondary btn-lg" href={REPO} target="_blank" rel="noreferrer">
            <GithubMark size={17} />
            <span>소스 코드</span>
          </a>
        </div>
      </section>

      <h2 className="sr-only">사용 방법</h2>
      <section className="steps">
        {[
          { icon: <ClipboardCheck size={22} />, t: '1. 붙여넣기', d: '원문을 붙여넣으면 개인정보가 색깔별로 표시돼요. 드래그로 원하는 부분을 더 가릴 수 있어요.' },
          { icon: <Bot size={22} />, t: '2. AI에게 보내기', d: '[이름_1], [전화_1]로 바뀐 글을 복사해 ChatGPT·Claude·Gemini에 그대로 붙여넣으세요.' },
          { icon: <Undo2 size={22} />, t: '3. 답변 되돌리기', d: 'AI 답변을 ‘되돌리기’에 붙여넣으면 자리표시자가 원래 이름과 번호로 돌아와요.' },
        ].map((s) => (
          <Card key={s.t} className="step">
            <div className="step-icon">{s.icon}</div>
            <h3>{s.t}</h3>
            <p>{s.d}</p>
          </Card>
        ))}
      </section>

      <DemoViewer />

      <section className="features">
        <h2>이런 것까지 해요</h2>
        <div className="feature-grid">
          {[
            { icon: <ScanSearch size={20} />, t: '한국형 개인정보 17종', d: '주민·외국인등록번호(체크섬 검증), 휴대폰·유선전화, 계좌·카드(Luhn 검증), 사업자·법인번호, 여권·운전면허, 차량번호, 도로명 주소, 이름까지.' },
            { icon: <KeyRound size={20} />, t: '개발자 비밀값', d: 'OpenAI·Anthropic·AWS·GitHub·Slack·Stripe 키, JWT, DB 접속 비밀번호, password= 값, Bearer 토큰을 로그에서 찾아 가려요.' },
            { icon: <Undo2 size={20} />, t: '되돌릴 수 있는 가림', d: '같은 값은 항상 같은 표시로. AI가 표기를 조금 바꿔도 복원하고, 복원 키는 이 기기에만 저장돼요.' },
            { icon: <FileLock2 size={20} />, t: '서식 그대로 문서 가림', d: 'Word·Excel·PowerPoint·한글(HWPX)은 서식을 유지한 채 글자만 바꾸고, 작성자 정보와 미리보기 이미지도 지워요. PDF는 복원 불가능한 이미지 PDF로, 스캔본도 OCR로 가려요.' },
            { icon: <ImageOff size={20} />, t: '캡처 이미지 OCR 가림', d: '카톡 캡처·신분증·학생증·자동차등록증에서 글자와 얼굴을 찾아 자동으로 가려요. 비스듬히 찍은 사진도 펴서 인식해요. QR 코드와 사진 위치정보(EXIF)도 처리.' },
            { icon: <WifiOff size={20} />, t: '완전 오프라인', d: '서버가 없습니다. 앱으로 설치하면 비행기 모드에서도 동작하고, 보안 정책으로 외부 전송 자체가 차단돼요.' },
          ].map((f) => (
            <div key={f.t} className="feature">
              <div className="feature-icon">{f.icon}</div>
              <div>
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="extension" id="extension">
        <Card className="ext-card">
          <div className="ext-text">
            <p className="eyebrow">브라우저 확장 프로그램</p>
            <h2>붙여넣는 순간 알아서 가리기</h2>
            <p>
              확장 프로그램을 설치하면 ChatGPT·Claude·Gemini·Perplexity·Copilot·뤼튼·클로바X 입력창에 글을 붙여넣을 때 <b>자동으로 개인정보가 가려져</b> 들어가고, AI 답변에서는 자리표시자가{' '}
              <b>원래 값으로 보여요</b>(내 화면에서만). 복사할 때도 원래 값으로 복사됩니다.
            </p>
            <ol>
              <li>아래 버튼으로 파일을 받아 압축을 풉니다.</li>
              <li>
                브라우저의 확장 프로그램 페이지를 엽니다. 아래 주소를 누르면 복사되니 새 탭 주소창에 붙여넣으세요.
                <span className="ext-page-links">
                  {EXT_PAGES.map((p) => (
                    <ExtPageLink key={p.url} name={p.name} url={p.url} current={p.url === currentBrowserUrl()} />
                  ))}
                </span>
              </li>
              <li>오른쪽 위 <b>개발자 모드</b>를 켜고 <b>압축해제된 확장 프로그램을 로드</b> → 풀어 둔 폴더를 선택합니다.</li>
              <li>이미 열려 있던 ChatGPT·Gemini 등의 탭은 <b>새로고침</b>해야 동작해요. (확장 아이콘을 누르면 이 탭에서 동작 중인지 알려 줘요)</li>
            </ol>
            <a className="btn btn-primary btn-lg" href="garim-extension.zip" download>
              <Puzzle size={17} />
              <span>확장 프로그램 받기 (.zip)</span>
            </a>
          </div>
          <div className="ext-demo" aria-hidden="true">
            <div className="ext-demo-input">
              <span className="chip static g-person">[이름_1]</span> 과장님께 <span className="chip static g-contact">[전화_1]</span>로 연락…
            </div>
            <div className="ext-demo-toast">
              <b>가림</b> 개인정보 3곳을 가려서 붙여넣었어요 <em>원문으로</em>
            </div>
            <div className="ext-demo-answer">
              네, <mark>김민수</mark> 과장님께 <mark>010-1234-5678</mark>로 연락드리겠습니다.
            </div>
          </div>
        </Card>
      </section>

      <section className="faq">
        <h2>자주 묻는 질문</h2>
        {FAQ.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <div className="faq-a">{a}</div>
          </details>
        ))}
      </section>

      <section className="shortcuts">
        <Card className="card-pad">
          <h3>
            <PlaneTakeoff size={18} /> 단축키
          </h3>
          <ul>
            <li>
              <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 가린 결과 복사
            </li>
            <li>
              <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd> 클립보드를 가려서 바로 다시 복사
            </li>
            <li>
              <kbd>Alt</kbd> + <kbd>1</kbd>~<kbd>5</kbd> 탭 이동
            </li>
          </ul>
        </Card>
        <Card className="card-pad">
          <h3>
            <Lock size={18} /> 알아 두세요
          </h3>
          <p className="muted">
            가림은 실수를 줄여 주는 도구이지 법적 비식별화 조치를 보증하지 않아요. 민감한 문서는 결과를 반드시 확인하고, 회사 보안 정책을 따르세요.
          </p>
        </Card>
      </section>
    </div>
  )
}
