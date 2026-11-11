1. UI 还是太丑了。 请你先重构Pluging和Skills界面，参考@docs/assets/ui-reference/connector-1.png 和 docs/assets/ui-reference/connector-2.png
2. 把Skills的几个例子给删去。 内置这些Skills吧：
- zh-humanizer
- intelliegen ui的skills： 把一些Good practice放在里面

3. 把ui render结合https://github.com/thesysdev/open-intelligent-ui做优化： 默认加载的时候上下文短，把更多的信息放在 intelliegen ui skills里面
4. 加上 @docs/inbox里面的支持
5. 实现多用户功能，使用邮箱登录和注册。（暂时先不需要接码）
6. 让一个Agent调研一下https://github.com/Tomyail/herdr-connect这个，是否可以将来实现，我们的GenseBot直接和本地的hc通过tailscale链接？
7. 上下文压缩