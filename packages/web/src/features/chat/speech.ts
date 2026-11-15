// The browser's own speech: dictation into the composer and reading an answer aloud. Both are absent in some
// browsers; callers check `supported`.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { report } from '../../app/client'

interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
  start(): void
  stop(): void
}

const RecognitionCtor = (window as unknown as Record<string, unknown>).SpeechRecognition ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition

/** Dictation: each finished phrase goes to `onText`. */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const recognition = useRef<Recognition | null>(null)
  const sink = useRef(onText)
  sink.current = onText

  useEffect(() => () => recognition.current?.stop(), [])

  const stop = () => recognition.current?.stop()
  const start = () => {
    if (!RecognitionCtor) return
    const r = new (RecognitionCtor as new () => Recognition)()
    r.lang = navigator.language || 'zh-CN'
    r.continuous = true
    r.interimResults = false
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]!
        if (result.isFinal) sink.current(result[0]!.transcript.trim())
      }
    }
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') report(new Error('没有麦克风权限，请在浏览器里允许后再试。'))
    }
    r.onend = () => {
      recognition.current = null
      setListening(false)
    }
    recognition.current = r
    try {
      r.start()
      setListening(true)
    } catch (e) {
      recognition.current = null
      report(e)
    }
  }

  return { supported: !!RecognitionCtor, listening, stop, toggle: () => (recognition.current ? stop() : start()) }
}

// One answer is read at a time; `speaking` is the id of the one being read.
let speaking: string | null = null
const listeners = new Set<() => void>()
const setSpeaking = (id: string | null) => {
  speaking = id
  for (const l of listeners) l()
}

export const canSpeak = 'speechSynthesis' in window

/** Markdown read aloud would spell out its marks; keep the words. */
const plain = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?```/g, ' 代码略。 ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|~]/g, '')

/** Reads `text` aloud, or stops if `id` is the one being read. */
export function useSpeech(id: string) {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
    () => speaking,
  )
  useEffect(
    () => () => {
      if (speaking === id) {
        speechSynthesis.cancel()
        setSpeaking(null)
      }
    },
    [id],
  )
  return {
    speaking: current === id,
    toggle(text: string) {
      speechSynthesis.cancel()
      if (speaking === id) return setSpeaking(null)
      const utterance = new SpeechSynthesisUtterance(plain(text))
      utterance.onend = utterance.onerror = () => speaking === id && setSpeaking(null)
      setSpeaking(id)
      speechSynthesis.speak(utterance)
    },
  }
}
