# pi-durable 验证脚本

路线图 3 阶段 1 的实现前验证（V1、V3、V4、V5）。一次性脚本，不是产品代码。结果记录在 [路线图 3](../../docs/plans/roadmap-3.md) 的“实现前验证”一节。

```bash
cd spikes/pi && npm install
node --env-file=../../.env v1/relay.mjs          # V1 中转站：流式、工具调用、工具结果、思考强度
node --env-file=../../.env v4/entries-fork.mjs   # V3、V4：自定义 entry、被动写入、fork 命中缓存、重启
node v5/watch.mjs                                # V5：watch() 的帧大小（faux provider，不需要密钥）
```

脚本只从环境变量读取密钥，不打印。依赖版本锁定为 1.4.0。
