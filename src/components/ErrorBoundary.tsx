import { Component, type ReactNode } from 'react'

interface State {
  error: Error | null
}

/** Keeps a crash in one view from blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="card crash">
        <h2>화면을 그리는 중 문제가 생겼어요</h2>
        <p className="muted">입력한 내용은 어디에도 전송되지 않았어요. 다시 시도하거나 페이지를 새로고침해 주세요.</p>
        <pre>{this.state.error.message}</pre>
        <div className="row gap">
          <button type="button" className="btn btn-primary btn-md" onClick={() => this.setState({ error: null })}>
            다시 시도
          </button>
          <button type="button" className="btn btn-secondary btn-md" onClick={() => window.location.reload()}>
            새로고침
          </button>
        </div>
      </div>
    )
  }
}
