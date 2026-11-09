# GitHub 门房（DSH 插件）

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的 GitHub 通道插件：**先登录，再搬运**。

- **登录**：设置页一键**设备码登录**（OAuth App Device Flow，不需要 client secret）；也可以直接粘 Personal Access Token。
- **上传**：把本机的 DSH 插件同步到 GitHub 私有库，一个插件一个库，增量、自动建库、未改动自动跳过。
- **拉取/安装**：用 GitHub tarball 把仓库拉回本地（**不需要 git**），并挂进 DSH profile；或用 `git clone` 路线装回。

它本身放在一个**公开仓库**里，因为这个插件的意义就是「新机器上第一块砖」：
换机器时，你不必先手动拷 token、也不必先装 git —— 匿名装它，登录一次，之后所有私有库就都可达了。

## 安装

```powershell
# 方式一：直接装（公开库，匿名可拉）
dsh plugin --profile desktop add https://api.github.com/repos/pandaQ1/dsh-plugin-github-upload/tarball/main

# 方式二：拷目录后挂载
dsh plugin --profile desktop add "D:\桌面\ai插件\GitHubAI插件自动上传"
```

装完**重启 DSH**，设置页会出现「GitHub 登录」。

## 登录

### 设备码登录（推荐）

1. 在 GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App 建一个
   （Homepage URL 随便填，如 `http://127.0.0.1`），建好后进该 App 设置，勾上 **Enable Device Flow**。
2. 把它的 **Client ID** 填进本插件：设置页输入框，或
   `github_upload { action: "init", clientId: "<Client ID>" }`
3. 点「设备码登录」→ 浏览器自动打开 `github.com/login/device` → 输入屏幕上的设备码 → 授权。
4. 宿主后台每 5 秒轮询一次，成功后令牌落到本机 `<配置目录>/token.txt`。

> Client ID 是公开信息，写在公开仓库/配置里都安全。整个流程**不会**用到 client secret。

### 粘 PAT（不想建 OAuth App 时）

设置页粘一个 token 即可（classic 勾 `repo`；fine-grained 给目标库 `Contents: Read/Write`）。

## 命令速查

| 动作 | 作用 |
| --- | --- |
| `status` | 自检：令牌 / 账号 / 插件根目录 / 待同步数 |
| `init` | 写配置（可顺手带上 `clientId`） |
| `login` / `login-status` / `login-cancel` / `logout` | 设备码登录、进度、取消、退出 |
| `auth` | 校验并保存一个 PAT |
| `scan` | 扫描插件，算建议仓库名与文件清单（只读、不联网） |
| `push` | 上传：`dir` / `dirs` / `all=true`，无改动自动跳过 |
| `download` | 用 tarball 拉取（**不吃 git**），`link=true` 直接挂进 profile |
| `install` | 用 `git clone` 装回（本机需要 git） |
| `link` | 把已有目录挂进 DSH profile |
| `list` | 已上传清单 |

## 权限与隐私

- 令牌只存在本机（`~/.dsh/github-plugin-upload/token.txt`，或 `GITHUB_TOKEN` 等环境变量），**从不写进仓库、不进 `.git/config`、不进命令行参数**（`git clone` 走一次性 `GIT_ASKPASS`）。
- 设备码登录默认只申请 `repo` 这一个 scope；不申请 `workflow`、不申请组织管理。
- 本仓库是通用工具代码，**不含任何账号信息、私有库清单或密钥**；你的库名不会被写进这里。
- 上传时不传 `.git`、不传 `node_modules`、单文件超限自动跳过。

## 配合「Harness 管家」完成整机恢复

```
新机器
 1. 匿名装本插件（上面那条命令）
 2. 设备码登录一次
 3. github_upload { action: "download", all: true, link: true }   # 不吃 git 把插件全拉回来
 4. 装「Harness 管家」→ butler_record { action: "restore" }        # 按账本恢复设置与规则
 5. 重启 DSH
```

## 已知限制

- `install` 依赖 `git`；没有 git 的机器请用 `download`。
- 设备码登录需要你自己建一个 OAuth App（GitHub 没有「免注册登录」的公开通道）；不建就用 PAT。
- tarball 下载走 GitHub API，私有库需要有效令牌；公开库匿名即可。

MIT License.
