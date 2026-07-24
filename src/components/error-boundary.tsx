'use client'

import * as React from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

/**
 * Global Error Boundary — catches any uncaught React render error and
 * shows a friendly "Something went wrong" screen instead of the raw
 * Next.js error page.
 *
 * The user can tap "Try again" to reload the page (which usually fixes
 * the issue since it's typically a transient hydration or data error).
 *
 * This wraps the entire app in layout.tsx so ANY render error in ANY
 * component gets caught.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log to console for debugging (Vercel captures console.error)
    console.error('[ErrorBoundary] Caught error:', error, errorInfo)
  }

  handleReload = () => {
    // Hard reload — clears any stale state
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="text-2xl font-bold">Something went wrong</div>
          <div className="max-w-md text-sm text-muted-foreground">
            An unexpected error occurred. This is usually a temporary issue —
            reloading the page should fix it.
          </div>
          {this.state.error && (
            <details className="max-w-md rounded-lg border bg-muted/30 p-3 text-left text-xs">
              <summary className="cursor-pointer font-medium">Error details</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all text-muted-foreground">
                {this.state.error.message}
              </pre>
            </details>
          )}
          <Button onClick={this.handleReload} variant="outline" size="sm" className="gap-1.5">
            <RefreshCw className="h-4 w-4" /> Try again
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}
