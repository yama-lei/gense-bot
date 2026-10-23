import { useEffect, useRef, useState } from 'react'
import type { AuthEvent, AuthType } from '@earendil-works/pi-ai'
import type { LoginPrompt } from '@gense/core/protocol'
import type { Store } from '../store'
import { Select } from './Select'

// The customize page's model services (roadmap-3 R62): the user signs in with an API key or a subscription, and the
// service's models join the model menu. The host runs the login; this page shows its events and answers its prompts.

interface Run {
  provider: string
  name: string
  events: AuthEvent[]
  prompts: { id: string; prompt: LoginPrompt }[]
  cancel: () => void
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function ModelAccounts({ store }: { store: Store }) {
  const { providers } = store.state
  const signedIn = providers.filter((p) => p.configured)
  const [picked, setPicked] = useState('')
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = providers.find((p) => p.id === picked)
  const running = useRef<Run | null>(null)
  // Leaving the page ends a login that still waits on the user.
  useEffect(() => () => running.current?.cancel(), [])

  const start = (type: AuthType) => {
    if (!current) return
    setError(null)
    const update = (fn: (r: Run) => Run) => setRun((r) => (r && r.provider === current.id ? fn(r) : r))
    const login = store.loginModel(current.id, type, {
      event: (e) => update((r) => ({ ...r, events: [...r.events, e] })),
      prompt: (id, prompt) => update((r) => ({ ...r, prompts: [...r.prompts, { id, prompt }] })),
      promptDone: (id) => update((r) => ({ ...r, prompts: r.prompts.filter((p) => p.id !== id) })),
    })
    const next: Run = { provider: current.id, name: current.name, events: [], prompts: [], cancel: login.cancel }
    running.current = next
    setRun(next)
    login.done.then(
      () => setPicked(''),
      (e: unknown) => setError(message(e)),
    ).finally(() => {
      if (running.current === next) running.current = null
      setRun((r) => (r?.provider === next.provider ? null : r))
    })
  }

  return (
    <>
      <p className="muted small">服务器提供的模型所有人都能用。你也可以登录自己的模型服务（API Key 或订阅账号），它的模型会出现在模型菜单里。凭据加密保存在服务器上。</p>
      {signedIn.length > 0 && (
        <ul className="list rows">
          {signedIn.map((p) => (
            <li key={p.id} className="row">
              <div className="row-main">
                <strong>
                  {p.name} <span className="tag">{p.configured === 'oauth' ? '订阅' : 'API Key'}</span>
                </strong>
              </div>
              <button className="btn" onClick={() => void store.logoutModel(p.id).catch((e: unknown) => setError(message(e)))}>
                退出
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="model-login">
        <div className="model-login-pick">
          <Select
            label="模型服务"
            value={picked}
            searchable
            options={[{ value: '', label: '选择一个模型服务…' }, ...providers.map((p) => ({ value: p.id, label: p.name, ...(p.configured && { tag: '已登录' }) }))]}
            onChange={(v) => {
              setPicked(v)
              setError(null)
            }}
          />
          {current?.apiKey && (
            <button className="btn" disabled={!!run} onClick={() => start('api_key')}>
              用 API Key 登录
            </button>
          )}
          {current?.oauth && (
            <button className="btn" disabled={!!run} title={current.oauth} onClick={() => start('oauth')}>
              用订阅账号登录
            </button>
          )}
        </div>
        {run && <LoginPanel run={run} store={store} onError={setError} />}
        {error && <p className="small error-text">{error}</p>}
      </div>
    </>
  )
}

function LoginPanel({ run, store, onError }: { run: Run; store: Store; onError: (e: string) => void }) {
  const progress = run.events.findLast((e) => e.type === 'progress')
  return (
    <div className="plugin-settings model-login-run" aria-live="polite">
      <strong>登录 {run.name}</strong>
      {run.events.map((e, i) => {
        switch (e.type) {
          case 'info':
            return (
              <p key={i} className="small">
                {e.message}
                {e.links?.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
                    {' '}
                    {l.label ?? l.url}
                  </a>
                ))}
              </p>
            )
          case 'auth_url':
            return (
              <p key={i} className="small">
                {e.instructions ?? '在新窗口中完成授权：'}{' '}
                <a href={e.url} target="_blank" rel="noreferrer">
                  打开授权页面
                </a>
              </p>
            )
          case 'device_code':
            return (
              <p key={i} className="small">
                打开{' '}
                <a href={e.verificationUri} target="_blank" rel="noreferrer">
                  {e.verificationUri}
                </a>{' '}
                并输入代码 <code className="device-code">{e.userCode}</code>
              </p>
            )
          default:
            return null
        }
      })}
      {progress && <p className="small muted">{progress.message}</p>}
      {run.prompts.map((p) => (
        <PromptForm key={p.id} prompt={p.prompt} onAnswer={(value) => void store.answerLogin(p.id, value).catch((e: unknown) => onError(message(e)))} />
      ))}
      <div className="setting-actions">
        <button type="button" className="btn" onClick={run.cancel}>
          取消登录
        </button>
      </div>
    </div>
  )
}

function PromptForm({ prompt, onAnswer }: { prompt: LoginPrompt; onAnswer: (value: string) => void }) {
  const [value, setValue] = useState(prompt.type === 'select' ? (prompt.options[0]?.id ?? '') : '')
  return (
    <form
      className="setting"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) onAnswer(prompt.type === 'select' ? value : value.trim())
      }}
    >
      <span className="setting-label">{prompt.message}</span>
      <span className="setting-secret">
        {prompt.type === 'select' ? (
          <Select label={prompt.message} value={value} options={prompt.options.map((o) => ({ value: o.id, label: o.label, ...(o.description && { description: o.description }) }))} onChange={setValue} />
        ) : (
          <input
            type={prompt.type === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            autoFocus
            aria-label={prompt.message}
            placeholder={prompt.placeholder ?? ''}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <button type="submit" className="btn primary" disabled={!value.trim()}>
          确定
        </button>
      </span>
    </form>
  )
}
