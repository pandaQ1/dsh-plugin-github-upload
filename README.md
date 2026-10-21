# GitHub插件自动上传（dsh-plugin-github-upload）

把 DSH 插件（**现有的**、**新做好的**）自动同步到 GitHub **私有库**，**一个插件一个库**。
以后换机器、重装 DSH，一条 `install` 就能把插件装回来并挂进 DSH。

工具名：`github_upload` · 动作：`status / init / auth / scan / push / install / link / list`

---

## 它解决了什么

| 以前 | 现在 |
| --- | --- |
| 插件散落在 `D:\桌面\ai插件`，没有版本、没有备份 | 每个插件一个私有仓库，提交历史可回溯 |
| 手动 `git init / add / commit / remote / push`，还得记得排除 `node_modules` | `push all=true` 一条命令增量同步，没改动自动跳过 |
| 换机器要一个个拷目录 | `install all=true` 全部装回，`link` 自动接进 DSH profile |
| 私有库要逐个建、逐个确认 | 首次 push 自动建**私有**库（发现是公开库会直接拒绝） |

---

## 一次性准备：GitHub 令牌（PAT）

只需要一次。

1. 打开 <https://github.com/settings/tokens> → **Generate new token (classic)**
2. 勾选 **`repo`**（整块，含私有库读写与建库）；如果你还要推 workflow 文件再勾 `workflow`
3. 生成后复制 `ghp_...`，在 DSH 里执行：

```json
{"action":"auth","token":"ghp_你的令牌"}
```

> 令牌会保存到 `%USERPROFILE%\.dsh\github-plugin-upload\token.txt`（仅本机）。
> 也可以完全不保存：设环境变量 `GITHUB_TOKEN`，插件优先读环境变量。
> fine-grained token 需要 **Administration: Read/Write**（建库）+ **Contents: Read/Write**（推文件），
> 且 Repository access 选 **All repositories**，否则新库建不出来。

---

## 常用动作

| 动作 | 干什么 | 典型调用 |
| --- | --- | --- |
| `status` | 自检：令牌、账号、插件根目录、已上传数、待同步数 | `{"action":"status"}` |
| `init` | 写配置（自动探测插件根目录 / profile / pnpm） | `{"action":"init"}` |
| `auth` | 校验并保存 PAT | `{"action":"auth","token":"ghp_..."}` |
| `scan` | 扫描插件，算建议仓库名与文件清单（只读、不联网） | `{"action":"scan"}` |
| `push` | 上传：单个 / 多个 / 全部增量 | `{"action":"push","all":true}` |
| `install` | 从私有库装回 | `{"action":"install","repo":"我/dsh-plugin-x"}` |
| `link` | 把已有目录挂进 DSH profile | `{"action":"link","dir":"D:\\桌面\\ai插件\\某插件"}` |
| `list` | 看已上传清单 | `{"action":"list","refresh":true}` |

### 第一次：把现有插件全部传上去

```json
{"action":"init"}
{"action":"scan"}
{"action":"push","all":true}
```

`push` 会为每个插件建一个私有库，仓库名默认取插件 `package.json` 的 `name`
（如 `dsh-plugin-edge-standard`；GitHub 不允许中文仓库名，中文标题只写进仓库描述和 README）。

### 做完新插件：一条命令

```json
{"action":"push","dir":"D:\\桌面\\ai插件\\新插件目录"}
```

或者继续 `{"action":"push","all":true}` —— 只传有改动的插件。

### 换机器 / 重装后：装回来

```json
{"action":"install","all":true,"link":true}
```

会把登记表里的插件克隆到安装目录，并写进 DSH profile（重启 DSH 生效）。

---

## 上传规则

- **只传插件本身**：`package.json` + `cordis.patch.yml` + `index.js` + `locale/` + `assets/` 等
- **默认排除**：`node_modules`、`.git`、`dist/build`、`.cache`、`__pycache__`、`.venv`、`.test-proj`、系统垃圾文件
- **单文件上限** 20MB（可用 `maxFileMB` 调），超限会在结果里列出来
- **删除会同步**：本地删掉的文件，下一次 push 会从远端树上移除
- **自动补 README**：插件没有 `README.md` 时，往仓库里写一份带安装说明的 README（不落盘、不改你的目录）
- **不动工作区**：走 GitHub REST 的 Git Data API（blobs → tree → commit → ref），不生成 `.git`，不写 `.gitignore`

## 状态文件（不在插件目录里）

```
%USERPROFILE%\.dsh\github-plugin-upload\
├─ config.json      # owner / 插件根目录 / 排除项 / 前缀 …
├─ registry.json    # 每个插件 → 仓库、分支、commit sha、文件数、上次推送时间
└─ token.txt        # PAT（可删，改用环境变量）
```

`config.json` 常用字段：

```json
{
  "owner": "auto",
  "repoPrefix": "",
  "pluginRoots": ["D:\\桌面\\ai插件"],
  "installRoot": "D:\\桌面\\ai插件",
  "exclude": ["*.psd"],
  "maxFileMB": 20,
  "profileDir": "C:\\Users\\<你>\\.dsh\\profiles\\desktop"
}
```

---

## 自测（无需令牌、无需外网）

```powershell
cd D:\桌面\ai插件\GitHubAI插件自动上传
node assets/selftest.mjs         # 本地 mock GitHub：建库→提交→增量→删除→install→link，46 项
node assets/selftest-index.mjs   # 工具定义与输出 schema 契约，25 项
```

## 退出码与报错

| 报错 | 含义 | 处理 |
| --- | --- | --- |
| `401 Bad credentials` | 令牌无效/过期 | 重新生成 PAT → `action=auth` |
| `403` | 令牌权限不足 | classic 勾 `repo`；fine-grained 给 Administration+Contents |
| `422 name already exists` | 同名库已存在（可能属于别的账号/组织） | 改 `repoPrefix` 或 `owner` |
| `目标库 … 是公开库，已拒绝上传` | 目标库不是私有的 | 改库为私有，或显式 `allowPublic=true` |
| `没找到 pnpm` | link 时找不到 pnpm | 手动 `cd <profile>; pnpm install` |

## 安装到 DSH

本插件本身就是 DSH 插件：目录 link 进 profile 即可（`apply(ctx)` 注册 `github_upload` 工具）。
profile 的 `package.json` 需要两处：

```json
{
  "dependencies": { "dsh-plugin-github-upload": "link:D:/桌面/ai插件/GitHubAI插件自动上传" },
  "dsh": { "profile": { "bundles": ["...", "dsh-plugin-github-upload"] } }
}
```

然后 `pnpm install`，重启 DSH。
