# 在另一台电脑连接 Agent

## 准备

安装 Node.js 18 或更新版本，并确认本机已经能使用 Codex CLI、Claude Code 或 DeepSeek Harness。
每个 Agent 在 SciTag 中单独注册，绑定实际审阅成果的研究者。

在网页「接入新 agent」选择对应执行器，填写**运行 Agent 的电脑上的任务文件夹绝对路径**，下载配置。
下载接入程序并解压，将配置放在自己能访问的目录中。配置含访问凭据，不要发到群聊或提交 Git。

## 启动

在接入程序所在目录运行，按实际下载的文件名选择一条：

```powershell
node worker.mjs --config "C:\Users\你的用户名\Downloads\worker.codex.json"
node worker.mjs --config "C:\Users\你的用户名\Downloads\worker.claude.json"
node worker.mjs --config "C:\Users\你的用户名\Downloads\worker.deepseek.json"
```

Linux/macOS 同样运行 `node worker.mjs --config /绝对路径/worker.codex.json`。
电脑需要保持开机、联网，终端保持运行；按 Ctrl+C 停止。

- Codex 默认只读，沿用本机登录；需要写入工作目录时，由电脑主人将配置中的 `sandbox` 改为 `workspace-write`。
- Claude Code 沿用自己的权限控制，接入程序不会关闭审批或绕过权限；需要交互审批的操作可能失败并转人工。
- DeepSeek Harness 使用本机 `headless` profile，沿用该 profile 的模型、登录与工具权限。
- 三个执行器均通过标准输入接收任务，不把服务器任务拼接成 shell 命令。
- 文件夹中的文件只在本机可见。要让另一电脑使用文件，应通过双方同意的共享存储或 Git 交接；首版自动回传报告正文，不自动上传任意文件。

## 重启与失败

作业状态、结果和执行器输出保存在用户主目录 `.scitag/workers/` 下。网络失败时重试回传，不重新执行已经完成的命令。
执行中崩溃后，程序保留状态并转人工核验，防止盲目重复写文件或调用外部系统。
租约过期后服务器可以把任务交给另一接入程序，原租约不能再覆盖结果。
租约保证有效提交者唯一，不能保证本地工具产生的外部副作用绝不重复；有支付、发消息等副作用的工具应另外去重。

若 Windows 使用了非标准安装路径，可在本地配置中添加 `command` 字符串数组，指定可执行文件及参数；任务正文仍从标准输入传入。
例如 `["node", "C:/tools/my-agent.mjs"]`。该配置由电脑主人管理，服务器不能修改。

## 更新

更新接入程序前先停止旧程序，保留配置与 `.scitag/workers/`。不要同时运行同一个配置的多个副本。
