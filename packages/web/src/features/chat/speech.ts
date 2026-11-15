// Dictation into the composer and reading an answer aloud. The server does both when it can (roadmap-7 C7,
// `/api/speech`); otherwise the browser's own speech, which some browsers lack. Callers check `supported`.
import { ASR_MAX_SECONDS, TTS_MAX_CHARS, type SpeechCapabilities, type SpeechText, type TtsRequest } from '@gense/protocol'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { report } from '../../app/client'
import { api, ApiError } from '../../lib/api'

// ── What the server can do ──

let caps: SpeechCapabilities | null = null
let asking: Promise<void> | null = null
const capListeners = new Set<() => void>()

/** Asked once per page; a server without speech, or one that fails to answer, leaves the browser's. */
function askCaps() {
  asking ??= api<SpeechCapabilities>('/api/speech').then(
    (c) => {
      caps = c
      for (const l of capListeners) l()
    },
    () => undefined,
  )
}

function useServerSpeech() {
  useEffect(askCaps, [])
  return useSyncExternalStore(
    (l) => {
      capListeners.add(l)
      return () => void capListeners.delete(l)
    },
    () => caps,
  )
}

// ── Dictation ──

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
const canRecord = !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined'

const RATE = 16_000

/** 16 kHz mono 16-bit PCM in a WAV file, what /api/speech/asr takes. */
function wav(chunks: Float32Array[], from: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const ratio = from / RATE
  const length = Math.floor(total / ratio)
  const view = new DataView(new ArrayBuffer(44 + length * 2))
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, length * 2, true)
  const all = new Float32Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  // Each output sample is the mean of the input samples it covers: enough of a low-pass for speech.
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(total, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += all[j]!
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)))
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return new Blob([view], { type: 'audio/wav' })
}

interface Recording {
  stop(): void
}

/** Records the microphone until `stop()` or ASR_MAX_SECONDS, then hands over the WAV. */
async function record(onDone: (audio: Blob) => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  // ScriptProcessor is deprecated but everywhere, and a worklet module is a lot more for a recorder.
  const processor = context.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  processor.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  source.connect(processor)
  processor.connect(context.destination)
  let done = false
  const stop = () => {
    if (done) return
    done = true
    clearTimeout(limit)
    processor.disconnect()
    source.disconnect()
    for (const t of stream.getTracks()) t.stop()
    void context.close()
    onDone(wav(chunks, context.sampleRate))
  }
  const limit = setTimeout(stop, ASR_MAX_SECONDS * 1000)
  return { stop }
}

/**
 * Dictation: each finished phrase goes to `onText`. With the server, the whole recording is sent when the user
 * stops (`transcribing` meanwhile); with the browser, phrases arrive as they are recognized.
 */
export function useDictation(onText: (text: string) => void) {
  const server = useServerSpeech()
  const useServer = !!server?.asr && canRecord
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recognition = useRef<Recognition | null>(null)
  const recording = useRef<Recording | null>(null)
  const sink = useRef(onText)
  sink.current = onText

  useEffect(
    () => () => {
      recognition.current?.stop()
      recording.current?.stop()
    },
    [],
  )

  const transcribe = async (audio: Blob) => {
    recording.current = null
    setListening(false)
    if (audio.size <= 44) return
    setTranscribing(true)
    try {
      const res = await fetch('/api/speech/asr', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: audio })
      const data = (await res.json().catch(() => null)) as (SpeechText & { error?: string }) | null
      if (!res.ok) throw new ApiError(data?.error ?? (res.status === 429 ? '听写太频繁，请稍后再试' : `听写失败（${res.status}）`), res.status)
      if (data?.text.trim()) sink.current(data.text.trim())
    } catch (e) {
      report(e)
    }
    setTranscribing(false)
  }

  const startServer = async () => {
    try {
      recording.current = await record((audio) => void transcribe(audio))
      setListening(true)
    } catch (e) {
      report((e as Error)?.name === 'NotAllowedError' ? new Error('没有麦克风权限，请在浏览器里允许后再试。') : e)
    }
  }

  const startBrowser = () => {
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

  const stop = () => {
    recognition.current?.stop()
    recording.current?.stop()
  }
  const active = () => !!recognition.current || !!recording.current

  return {
    supported: useServer || !!RecognitionCtor,
    listening,
    transcribing,
    stop,
    toggle: () => (active() ? stop() : transcribing ? undefined : useServer ? void startServer() : startBrowser()),
  }
}

// ── Reading aloud ──

// One answer is read at a time; `speaking` is the id of the one being read.
let speaking: string | null = null
let halt: (() => void) | null = null
const listeners = new Set<() => void>()
const setSpeaking = (id: string | null) => {
  speaking = id
  for (const l of listeners) l()
}

const browserTts = 'speechSynthesis' in window
/** Whether reading aloud is offered at all: the server's voice, or the browser's. */
export function useCanSpeak() {
  const server = useServerSpeech()
  return !!server?.tts || browserTts
}

/** Markdown read aloud would spell out its marks; keep the words. */
const plain = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?```/g, ' 代码略。 ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|~]/g, '')

function speakInBrowser(id: string, text: string) {
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.onend = utterance.onerror = () => speaking === id && setSpeaking(null)
  speechSynthesis.speak(utterance)
  halt = () => speechSynthesis.cancel()
}

function speakOnServer(id: string, text: string) {
  const abort = new AbortController()
  const audio = new Audio()
  let url = ''
  halt = () => {
    abort.abort()
    audio.pause()
    if (url) URL.revokeObjectURL(url)
  }
  const end = () => {
    if (url) URL.revokeObjectURL(url)
    if (speaking === id) setSpeaking(null)
  }
  const body: TtsRequest = { text: text.slice(0, TTS_MAX_CHARS) }
  void fetch('/api/speech/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal })
    .then(async (res) => {
      if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? (res.status === 429 ? '朗读太频繁，请稍后再试' : `朗读失败（${res.status}）`), res.status)
      url = URL.createObjectURL(await res.blob())
      if (speaking !== id) return end()
      audio.src = url
      audio.onended = audio.onerror = end
      await audio.play()
    })
    .catch((e: unknown) => {
      if (abort.signal.aborted) return
      end()
      report(e)
    })
}

/** Reads `text` aloud, or stops if `id` is the one being read. */
export function useSpeech(id: string) {
  const server = useServerSpeech()
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
        halt?.()
        setSpeaking(null)
      }
    },
    [id],
  )
  return {
    speaking: current === id,
    toggle(text: string) {
      halt?.()
      halt = null
      if (speaking === id) return setSpeaking(null)
      setSpeaking(id)
      if (server?.tts) speakOnServer(id, plain(text))
      else speakInBrowser(id, plain(text))
    },
  }
}
