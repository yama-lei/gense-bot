import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { IconCheck, IconCopy } from './Icons'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const lang = /language-(\w+)/.exec(className ?? '')?.[1]
            const code = String(children).replace(/\n$/, '')
            if (!lang && !code.includes('\n')) return <code className="inline">{children}</code>
            return <CodeBlock lang={lang ?? 'text'} code={code} />
          },
          table: ({ children }) => (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{lang}</span>
        <button
          className="icon-btn small"
          aria-label="复制代码"
          onClick={() => {
            navigator.clipboard?.writeText(code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <IconCheck width={15} height={15} /> : <IconCopy width={15} height={15} />}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}
