// Photos and street routes come from the server through the view host's `tool.call` (docs/plans/openui.md), in
// place of open-intelligent-ui's /api routes. The rendered view registers its host; the results are not per chat.
type Call = (name: string, args: unknown) => Promise<{ content: string; isError?: boolean; structuredContent?: unknown }>

let call: Call | undefined

export function setLookupHost(next: Call) {
  call = next
}

export async function lookup<T>(name: 'ui_photos' | 'ui_route', args: Record<string, unknown>): Promise<T> {
  if (!call) throw new Error('no view host')
  const result = await call(name, args)
  if (result.isError) throw new Error(result.content)
  return result.structuredContent as T
}
