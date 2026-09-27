'use client'

/**
 * SecretScreenRecorder — an INVISIBLE developer tool for capturing demo
 * footage of the site (mobile + desktop form factors) so it can be handed
 * to an AI to produce adverts.
 *
 * ── How it works ──
 * Paste (or type) a magic word anywhere on the site:
 *
 *   secretscreenrecordmobileon   → opens a phone-sized (390×844) popup of
 *                                  the site and starts screen recording;
 *                                  pick the small NeutralWire window in
 *                                  the browser share dialog.
 *   secretscreenrecordmobileoff  → stops the recording and downloads the
 *                                  video to this device. Works pasted in
 *                                  the main window OR inside the popup.
 *   secretscreenrecorddesktopon  → starts screen recording of this tab
 *                                  (desktop layout); the share dialog
 *                                  pre-selects the current tab.
 *   secretscreenrecorddesktopoff → stops + downloads the desktop video.
 *
 * ── Design notes ──
 * - Renders NOTHING (returns null) — zero UI, zero discoverability, no
 *   bundle-visible hint in the page. The only footprint is a passive
 *   document-level `paste`/`keydown` listener.
 * - While a DESKTOP recording is running we show absolutely no toasts or
 *   indicators — any on-screen element would end up in the footage. The
 *   browser's own share dialog is the only start feedback; the download
 *   is the stop feedback. (Toasts for the mobile mode are safe — those
 *   record the popup window, never this one.)
 * - The mobile popup (opened with ?nwrec=1) forwards OFF words to its
 *   opener via postMessage, so stopping works from either window.
 * - Stopping also fires automatically when the user clicks the browser's
 *   "Stop sharing" bar or closes the captured window (track `ended`) —
 *   the file still downloads, nothing is lost.
 * - No body scroll-lock, no interval timers, nothing that can freeze the
 *   page. MediaRecorder chunks arrive every second, so even a crashed
 *   tab loses at most ~1s… a `beforeunload` guard warns before losing an
 *   active recording.
 * - iOS Safari has no getDisplayMedia → friendly toast, nothing breaks.
 */

import * as React from 'react'
import { toast } from '@/hooks/use-toast'

const WORDS = {
  mobileOn: 'secretscreenrecordmobileon',
  mobileOff: 'secretscreenrecordmobileoff',
  desktopOn: 'secretscreenrecorddesktopon',
  desktopOff: 'secretscreenrecorddesktopoff',
} as const

type RecMode = 'mobile' | 'desktop'

interface RecSession {
  mode: RecMode
  recorder: MediaRecorder
  chunks: Blob[]
  mimeType: string
  stream: MediaStream
  popup: Window | null
}

/** Best supported video container/codec (Chrome: vp9 webm, Safari: mp4). */
function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ]
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c
    } catch {
      /* keep trying */
    }
  }
  return ''
}

export function SecretScreenRecorder() {
  const recRef = React.useRef<RecSession | null>(null)

  // Warn before closing the tab while a recording is in flight.
  const onBeforeUnload = React.useCallback((e: BeforeUnloadEvent) => {
    e.preventDefault()
    e.returnValue = ''
  }, [])

  const stopRecording = React.useCallback(() => {
    const rec = recRef.current
    if (!rec) return
    recRef.current = null
    window.removeEventListener('beforeunload', onBeforeUnload)
    // recorder.stop() triggers onstop → file download + save toast.
    try {
      if (rec.recorder.state !== 'inactive') rec.recorder.stop()
    } catch {
      /* already stopped */
    }
    try {
      rec.stream.getTracks().forEach((t) => t.stop())
    } catch {
      /* already stopped */
    }
    try {
      rec.popup?.close()
    } catch {
      /* already closed */
    }
    console.log('[nw-rec] stopped')
  }, [onBeforeUnload])

  const startRecording = React.useCallback(
    async (mode: RecMode) => {
      if (recRef.current) {
        console.log('[nw-rec] already recording — ignoring', mode)
        return
      }
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getDisplayMedia !== 'function'
      ) {
        toast({
          title: 'Screen recording not supported',
          description:
            'This browser has no screen-capture API (getDisplayMedia). Try Chrome or Edge.',
        })
        return
      }

      // ── Mobile mode: open a phone-sized window running the site ──
      // 390×844 = iPhone 14 Pro viewport → the responsive site renders
      // its full mobile layout inside the popup.
      let popup: Window | null = null
      if (mode === 'mobile') {
        const w = 390
        const h = 844
        const left = Math.max(0, Math.round((window.screen.width - w) / 2))
        const top = Math.max(0, Math.round((window.screen.height - h) / 2))
        popup = window.open(
          '/?nwrec=1',
          'nw-rec-mobile',
          `width=${w},height=${h},left=${left},top=${top}`,
        )
        // Safe to toast: mobile footage records the POPUP, never this window.
        if (popup) {
          toast({
            title: 'Mobile recording armed',
            description:
              'Pick the small NeutralWire window in the share dialog. Paste secretscreenrecordmobileoff (here or in the popup) to stop & download.',
            duration: 8000,
          })
        } else {
          toast({
            title: 'Popup blocked',
            description:
              'Allow popups for this site, then paste secretscreenrecordmobileon again.',
          })
        }
      }

      // ── Ask the browser what to capture ──
      // desktop: preferCurrentTab pre-selects this tab (the site at full
      //          desktop size) — one Enter and it's rolling.
      // mobile:  displaySurface:'window' opens the picker on the Windows
      //          section so the phone-sized popup is easy to find.
      // A 120s safety timeout covers browsers where the picker promise
      // never settles (headless, embedded webviews) — otherwise the
      // recorder would silently wait forever.
      let stream: MediaStream
      try {
        const opts =
          mode === 'mobile'
            ? { video: { frameRate: 30, displaySurface: 'window' }, audio: false }
            : {
                video: { frameRate: 30 },
                audio: false,
                preferCurrentTab: true,
                selfBrowserSurface: 'include',
              }
        const gdmPromise = navigator.mediaDevices.getDisplayMedia(
          opts as unknown as DisplayMediaStreamOptions,
        )
        // If the user confirms AFTER we already timed out, kill the
        // late stream immediately so nothing leaks.
        let timedOut = false
        gdmPromise
          .then((s) => {
            if (timedOut) s.getTracks().forEach((t) => t.stop())
          })
          .catch(() => {
            /* handled by the race below */
          })
        stream = await Promise.race([
          gdmPromise,
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              timedOut = true
              reject(
                new DOMException(
                  'Screen picker timed out after 2 minutes',
                  'TimeoutError',
                ),
              )
            }, 120_000)
          }),
        ])
      } catch (err) {
        // NotAllowedError = the user dismissed the share dialog.
        try {
          popup?.close()
        } catch {
          /* ignore */
        }
        const cancelled =
          err instanceof DOMException &&
          (err.name === 'NotAllowedError' || err.name === 'TimeoutError')
        console.log('[nw-rec] capture failed:', err)
        toast({
          title: cancelled ? 'Recording cancelled' : 'Screen capture failed',
          description: cancelled
            ? 'The share dialog was dismissed — nothing is recording.'
            : String(err),
        })
        return
      }

      // ── MediaRecorder ──
      const mimeType = pickMimeType()
      const chunks: Blob[] = []
      let recorder: MediaRecorder
      try {
        recorder = new MediaRecorder(
          stream,
          mimeType
            ? { mimeType, videoBitsPerSecond: 8_000_000 }
            : { videoBitsPerSecond: 8_000_000 },
        )
      } catch (err) {
        console.log('[nw-rec] MediaRecorder failed:', err)
        try {
          stream.getTracks().forEach((t) => t.stop())
        } catch {
          /* ignore */
        }
        toast({ title: 'Recording failed', description: String(err) })
        return
      }

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunks.push(e.data)
      }
      recorder.onstop = () => {
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
        const blob = new Blob(chunks, { type: mimeType || 'video/webm' })
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        const name = `NeutralWire-${mode}-${stamp}.${ext}`
        // Trigger the download (works in normal tabs + installed PWAs).
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 30_000)
        const mb = (blob.size / 1_000_000).toFixed(1)
        console.log(`[nw-rec] saved ${name} (${mb} MB)`)
        toast({
          title: 'Recording saved',
          description: `${name} — ${mb} MB, downloading now.`,
        })
      }

      // User clicked the browser's "Stop sharing" bar or closed the
      // captured popup → track ends → save whatever we have.
      stream.getVideoTracks().forEach((t) =>
        t.addEventListener('ended', () => stopRecording()),
      )

      try {
        recorder.start(1000) // flush a chunk every second
      } catch (err) {
        console.log('[nw-rec] start failed:', err)
        try {
          stream.getTracks().forEach((t) => t.stop())
        } catch {
          /* ignore */
        }
        return
      }

      recRef.current = { mode, recorder, chunks, mimeType, stream, popup }
      window.addEventListener('beforeunload', onBeforeUnload)
      console.log(`[nw-rec] ${mode} recording started`)
    },
    [onBeforeUnload, stopRecording],
  )

  React.useEffect(() => {
    const handleMagicText = (raw: string) => {
      const text = raw.toLowerCase()

      // This window is a recording popup (?nwrec=1): never record from
      // here — just forward OFF words to the window that IS recording.
      const isRecPopup =
        window.location.search.includes('nwrec=1') && window.opener
      if (isRecPopup) {
        if (text.includes(WORDS.mobileOff) || text.includes(WORDS.desktopOff)) {
          console.log('[nw-rec] forwarding stop to opener')
          try {
            window.opener.postMessage({ type: 'nw-secret-rec-stop' }, '*')
          } catch {
            /* opener gone — the main window's track-ended fallback saves the file */
          }
        }
        return
      }

      if (text.includes(WORDS.mobileOn)) {
        void startRecording('mobile')
      } else if (text.includes(WORDS.desktopOn)) {
        void startRecording('desktop')
      } else if (
        text.includes(WORDS.mobileOff) ||
        text.includes(WORDS.desktopOff)
      ) {
        stopRecording()
      }
    }

    // 1) Paste — the documented trigger.
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text')
      if (text) handleMagicText(text)
    }

    // 2) Typing the word also works (buffer of recent characters).
    let typed = ''
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key && e.key.length === 1) {
        typed = (typed + e.key.toLowerCase()).slice(-64)
        handleMagicText(typed)
      }
    }

    // 3) Stop messages forwarded from the recording popup.
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'nw-secret-rec-stop') stopRecording()
    }

    document.addEventListener('paste', onPaste)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('message', onMessage)
    return () => {
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('message', onMessage)
      // If the component ever unmounts mid-recording, save what we have.
      stopRecording()
    }
  }, [startRecording, stopRecording])

  // Invisible by design.
  return null
}
