import 'katex/dist/katex.min.css'
import { Check, Copy } from 'lucide-react'
import { isValidElement, memo, useRef, type ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { cn } from '../../lib/cn'
import { copyText } from '../../lib/format'
import { useFlash } from '../../lib/hooks'

/** Models also write maths as \( … \) and \[ … \]; remark-math reads dollars. Code is left as it is. */
function dollars(text: string) {
  if (!text.includes('\\(') && !text.includes('\\[')) return text
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`).replace(/\\\(([^\n]+?)\\\)/g, (_, m: string) => `$${m.trim()}$`),
    )
    .join('')
}

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, flash] = useFlash()
  const code = isValidElement<{ className?: string }>(children) ? children : null
  const language = /language-([\w+#.-]+)/.exec(code?.props.className ?? '')?.[1]
  return (
    <div className="codeblock overflow-hidden rounded-xl border bg-code">
      <div className="flex h-9 items-center justify-between pr-1.5 pl-4 text-xs text-muted-foreground">
        <span>{language ?? '代码'}</span>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 hover:bg-hover hover:text-foreground"
          onClick={() => void copyText(ref.current?.textContent ?? '').then((ok) => ok && flash())}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre ref={ref} className="overflow-x-auto px-4 pb-3.5 font-mono text-[13px] leading-relaxed">
        {children}
      </pre>
    </div>
  )
}

const components: Components = {
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="table-scroll">
      <table {...props} />
    </div>
  ),
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
}

const remark = [remarkGfm, remarkMath]
const rehype: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [[rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { detect: false }]]

/** Model output as prose. `streaming` draws a caret after the last block. */
export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={cn('prose', streaming && 'streaming', className)}>
      <ReactMarkdown remarkPlugins={remark} rehypePlugins={rehype} components={components}>
        {dollars(text)}
      </ReactMarkdown>
    </div>
  )
})
