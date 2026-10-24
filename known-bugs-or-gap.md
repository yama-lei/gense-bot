1. https://github.com/thesysdev/open-intelligent-ui 我们的intelligent UI和期待中的相差很远，似乎阉割了很多内容，我们可以考虑如何重新设计
2. 沙盒应该要允许读取/tmp/的内容：
```
read
失败
9 ms
参数 {"path":"/tmp/crab/img4.jpeg"}
结果
[error] 只能读取本会话工作区（/data/sessions/0992cf5c-0fc0-4600-beca-75255f465089）和 Skills（/data/skills）里的文件
read
失败
10 ms
参数 {"path":"/tmp/crab/img5.jpeg"}
结果
[error] 只能读取本会话工作区（/data/sessions/0992cf5c-0fc0-4600-beca-75255f465089）和 Skills（/data/skills）里的文件
```
3. 