# GenseBot Web（Mock）

手机优先的网页前端。当前为 M0 Mock：数据存于浏览器 `localStorage`，回复由 `src/mock/engine.ts` 脚本生成，不调用模型。界面规格见 [docs/specs/web-ui.md](../docs/specs/web-ui.md)。

```sh
npm install
npm run dev       # 本地开发
npm run build     # 类型检查 + 构建
npx cf deploy     # 部署到 Cloudflare（需先 cf auth login）
```

在侧栏“更多 → 重置 Mock 数据”可恢复演示数据。
