// Roadmap-6 B3/B4: the Discover catalog is well-formed, and a preset's address round-trips through its template.
import { fillTemplate, fromTemplate } from '@gense/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pluginCatalog } from '../src/plugins/catalog.ts'
import { discoverCatalog } from '../src/plugins/discover.ts'

test('B3: every entry is unique, every built-in plugin is listed, and presets say how to add them', () => {
  const keys = discoverCatalog.map((d) => `${d.kind}:${d.id}`)
  assert.equal(new Set(keys).size, keys.length)
  assert.deepEqual(
    discoverCatalog.filter((d) => d.kind === 'builtin').map((d) => d.id),
    pluginCatalog.map((p) => p.id),
  )
  for (const d of discoverCatalog) {
    if (d.icon) assert.match(d.icon, /^<svg [^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/, d.id)
    if (d.kind === 'builtin') assert.equal(d.install, undefined, d.id)
    if (d.kind === 'mcp') assert.ok(d.install && 'mcp' in d.install && /^https:\/\//.test(d.install.mcp), d.id)
    if (d.kind === 'skill') assert.ok(d.install && 'git' in d.install && d.install.path?.endsWith(`/${d.id}`), d.id)
  }
})

test('B4: a preset fills its fields into the address, and the address is recognised as that preset', () => {
  const amap = discoverCatalog.find((d) => d.id === 'amap')!.install as { mcp: string; fields: { key: string }[] }
  assert.deepEqual(
    amap.fields.map((f) => f.key),
    [...amap.mcp.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
  )
  const url = fillTemplate(amap.mcp, { key: 'a b&c' })
  assert.equal(url, 'https://mcp.amap.com/mcp?key=a%20b%26c')
  assert.ok(fromTemplate(url, amap.mcp))
  assert.ok(!fromTemplate('https://example.com/mcp?key=x', amap.mcp))
  const alphaxiv = (discoverCatalog.find((d) => d.id === 'alphaxiv')!.install as { mcp: string }).mcp
  assert.ok(fromTemplate(`${alphaxiv}/`, alphaxiv))
  assert.ok(!fromTemplate(`${alphaxiv}/other`, alphaxiv))
})
