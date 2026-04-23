// Top-level error boundary. When any descendant throws during render, this
// catches the exception and shows the error message + stack instead of
// unmounting the whole tree (the "blank app" failure mode).
//
// React doesn't ship a function-component API for error boundaries — it
// has to be a class component. Kept minimal on purpose.

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
  info: ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Also log so devtools / terminal capture it.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info)
    this.setState({ error, info })
  }

  reset = (): void => this.setState({ error: null, info: null })

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="p-6 font-mono text-[12px] text-danger max-w-full overflow-auto h-full bg-panel">
        <div className="font-semibold text-[14px] mb-2">Renderer error</div>
        <div className="mb-2 whitespace-pre-wrap break-words">
          {this.state.error.message}
        </div>
        <details className="opacity-70">
          <summary>Stack</summary>
          <pre className="whitespace-pre-wrap break-words text-[10px]">
            {this.state.error.stack}
            {'\n---\n'}
            {this.state.info?.componentStack}
          </pre>
        </details>
        <button className="btn mt-3" onClick={this.reset}>
          Try again
        </button>
      </div>
    )
  }
}
