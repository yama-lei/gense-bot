import { definePlugin } from '../../registry.ts'
import { artifactExtension } from '../../display.ts'
import { Value } from 'typebox/value'
import { artifactInput, saveArtifact } from '../../display.ts'

export default definePlugin({
...{
  "id": "artifact",
  "name": "Artifact",
  "description": "在会话中展示文档、网页、代码等产物，并保存到会话工作区。",
  "sideEffect": false,
  "settings": []
},
issue: () => null,
extension: artifactExtension,
resources: { artifact_create: 'ui://artifact/view' },
viewTools: { artifact_save: { description: '把产物保存到工作区', async call(args, env, ctx) { if (!Value.Check(artifactInput, args)) throw new Error('参数无效'); const path = await saveArtifact(env, args, ctx); return { content: '已保存到 ' + path, structuredContent: { path } } } } }
})
