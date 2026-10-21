# 使用手册 · GitHub插件自动上传

面向「把 DSH 插件（现有 / 新做好的）自动传进 GitHub 私有库，一个插件一个库」这个目标，这里写清楚：
怎么配、怎么传、怎么装回来、出问题怎么查。

---

## 1. 结构

```
GitHubAI插件自动上传/
├─ index.js                 # 注册 github_upload 工具（动作编排 + 结果渲染）
├─ cordis.patch.yml         # DSH bundle patch：插入 github-upload 行
├─ package.json             # dsh.bundle.patch 指向 cordis.patch.yml
├─ icon.svg / locale/       # 图标与中英文标题
├─ README.md
└─ assets/
   ├─ lib.mjs               # 配置、登记表、插件扫描、blob sha、GitHub REST 客户端、profile link
   ├─ scan.mjs              # CLI：扫描插件（只读）
   ├─ push.mjs              # CLI：上传（建库 → blob → tree → commit → ref）
   ├─ install.mjs           # CLI：git clone 装回（GIT_ASKPASS 喂令牌，不写进 .git/config）
   ├─ selftest.mjs          # mock GitHub 全流程自测（46 项）
   └─ selftest-index.mjs    # 工具输出 schema 契约自测（25 项）
```

所有脚本零第三方依赖，可单独 `node assets/push.mjs --help` 式使用（参数见各文件头注释）。

---

## 2. 认证

令牌解析顺序（命中即用）：

1. 工具参数 `token`（一次性）
2. 环境变量：`GITHUB_TOKEN` /
 `GH_TOKEN` / `DSH_GITHUB_TOKEN`
3. `%USERPROFILE%\.dsh\github-plugin-upload\token.txt`
4. `config.json` 的 `token`（不推荐）

权限要求：

| 令牌类型 | 需要 |
| --- | --- |
| classic PAT | 勾 `repo`（私有库读写 + 建库）。要推 `.github/workflows` 再加 `workflow` |
| fine-grained | Repository permissions：**Administration: Read/Write**（建库）、**Contents: Read/Write**（推文件）；Repository access 选 **All repositories** |

`auth` 动作会调 `GET /user` 校验并把 scopes 打出来；fine-grained 令牌看不到 scopes，返回空数组属正常。

> 私有库 clone / push 都要令牌。仓库地址里不要写令牌（会被 `.git/config` 记下来），
> 本插件 `install` 用一次性 `GIT_ASKPASS` 脚本 + 环境变量把令牌交给 git。

---

## 3. 动作详解

### status
纯本地检查 + 一次 `GET /user`。输出 `checks` 列表：配置文件、令牌、账号、插件根目录、插件、登记表、待同步、DSH profile/pnpm。

### init
写 `config.json`（首次会探测：插件根目录 = 含 DSH 插件的目录；profile = `~/.dsh/profiles/desktop`；pnpm = DSH 自带）。可带 `roots` / `owner` / `repoPrefix` 覆盖。

### scan
遍历插件根目录（根本身是插件也算，否则找下一层子目录），判定「DSH 插件」= `package.json` + (`cordis.patch.yml` 或 `dsh.bundle.patch`) + 入口 `index.js`。
输出每个插件的建议仓库名、文件数、体积、是否已建库、是否有改动，以及被跳过的文件。

### push
1. `GET /repos/{owner}/{repo}` → 不存在则 `POST /user/repos`（`private: true`，`auto_init: false`）
2. 读分支头 → 读 commit → 读递归树（path → blob sha）
3. 本地算 git blob sha（`sha1("blob <len>\0" + content)`），逐个和远端比：
   - 相同 → 复用远端 sha（不传）
   - 不同 → `POST /git/blobs`（base64）
4. `POST /git/trees`（全量树，天然带回删除）→ `POST /git/commits` → `PATCH /git/refs/heads/<branch>`
5. 空库时用 `POST /git/refs` 建 `refs/heads/main`
6. 写 `registry.json`，并同步仓库描述为「插件标题 · DSH 插件」

同一插件第二次 push：`treeId` 相同 → **一次网络请求都不发**（`unchanged`）。
`force=true` 跳过这个快路径；`dryRun=true` 只算差异不写。

### install
`git clone --depth 1 --branch <默认分支> https://x-access-token@github.com/{owner}/{repo}.git <目录>`。
令牌通过 `GIT_ASKPASS` 临时脚本 + `DSH_GH_TOKEN` 环境变量传入，克隆完即删。
目录已存在默认跳过；`force=true` 会先把旧目录改名备份成 `<目录>.bak-<时间戳>`。
`link=true` 顺手挂进 profile（等同 `link` 动作）。
`url` 参数可指向 `file:///…`（自测用）或别的托管地址。

### link
改 DSH profile 的 `package.json`：
- `dependencies[包名] = "link:<绝对路径，正斜杠>"`
- `dsh.profile.bundles` 追加包名（去重）
然后跑 pnpm（优先用 DSH 自带 `resources/runtime/primary-runtime/dependencies/pnpm/pnpm.cjs`）。
`noInstall=true` 只改文件不跑 pnpm。**改完要重启 DSH。**

### list
读登记表；`refresh=true` 会联网确认仓库是否还在（删库会标 `missing`）。

---

## 4. 命名与排除

- 仓库名 = `repoPrefix` + `package.json` 的 `name`（只保留 `A-Za-z0-9._-`，其它字符折叠成 `-`，长度截到 90）
- 中文标题不进仓库名，写进 `description` 和自动生成的 README
- 默认排除目录/文件：`node_modules .git .hg .svn .idea .vscode dist build out .output coverage .cache .turbo .parcel-cache .pnpm-store __pycache__ .venv venv .pytest_cache .mypy_cache .test-proj .test-run .tmp tmp logs .DS_Store Thumbs.db desktop.ini`
- 额外排除写在 `config.json` 的 `exclude`（按文件/目录名匹配，小写比较）
- 单文件上限 `maxFileMB`（默认 20）；超限/符号链接会被跳过并在 `issues` 里列出

---

## 5. 状态与可追溯

`registry.json` 每个仓库一条：

```json
{
  "plugin": "dsh-plugin-edge-standard", "title": "插件发布规范",
  "owner": "your-login", "repo": "dsh-plugin-edge-standard",
  "branch": "main", "sha": "<commit>", "treeSha": "<tree>", "treeId": "<本地清单摘要>",
  "packageVersion": "1.0.0", "files": 18, "bytes": 84531, "pushedAt": "2026-10-22T..."
}
```

`treeId` 是「文件相对路径 + blob sha + 权限位」的 sha1，用来判断「本地有没有改动」，不需要联网。

---

## 6. 排查表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `令牌不可用：… 401` | PAT 失效 | 重新生成 → `auth` |
| `403 Resource not accessible` | 权限不够 / 组织禁建库 | classic 用 `repo`；组织需允许创建 |
| `422 Repository creation failed` | 同名库存在 | 改 `repoPrefix`/`owner`，或先删旧库 |
| push 成功但 GitHub 上没有文件 | 目标分支不是默认分支 | 看 `list` 里的 `branch`，或删库重来 |
| 中文插件名报错 | GitHub 不允许非 ASCII 仓库名 | 在 `package.json` 里给 `name` 用 ASCII（本插件会自动兜底 `dsh-plugin`） |
| `install` 卡住 | 令牌缺失且非 `file://` | 先 `auth`；或检查网络代理 |
| `link` 后 DSH 里没有工具 | 没重启 / pnpm install 没跑 | 重启 DSH；`cd <profile>; pnpm install` |
| 大量文件被跳过 | 被默认排除或被体积上限挡住 | 看 `issues` 里的「跳过 …」；调整 `config.json` |

---

## 7. 自测

```powershell
node assets/selftest.mjs        # 本地 mock GitHub REST，跑建库/提交/增量/删除/dry-run/拦公开库/install/link
node assets/selftest-index.mjs  # apply 注册、参数枚举、8 个动作的输出是否符合 output.schema
```

`selftest.mjs --keep` 保留临时目录便于排查。
