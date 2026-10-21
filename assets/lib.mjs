// 共享库：配置 / 登记表 / 插件扫描 / git blob sha / GitHub REST 客户端
//
// 设计原则：
// • 零第三方依赖（只用 node: 内置模块 + 全局 fetch），脚本可单独拷走运行
// • 只认「DSH 插件」：目录里必须有 package.json + (cordis.patch.yml 或 dsh.bundle.patch) + index.js
// • 状态（配置 / 登记表 / 令牌）全部放在插件目录之外，避免被一起上传
// • 一个插件一个私有库：repo 名默认取 package.json 的 name（ASCII，GitHub 仓库名不允许中文）

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LIB_DIR = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = dirname(LIB_DIR);

/** 默认排除：噪声目录 / 缓存 / 测试残留 / 系统垃圾。【不上传】 */
export const DEFAULT_EXCLUDES = [
  "node_modules", ".git", ".hg", ".svn", ".idea", ".vscode",
  "dist", "build", "out", ".output", "coverage", ".nyc_output",
  ".cache", ".turbo", ".parcel-cache", ".pnpm-store", ".pnpm",
  "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache",
  ".test-proj", ".test-run", ".tmp", "tmp", "logs",
  ".DS_Store", "Thumbs.db", "desktop.ini",
];

export const CONFIG_FILE = "config.json";
export const REGISTRY_FILE = "registry.json";
export const TOKEN_FILE = "token.txt";

export const DEFAULT_CONFIG = {
  $comment: "GitHub 私有库上传配置。owner=auto 表示用令牌对应的账号；pluginRoots 为空则自动探测；token 建议用环境变量或 token.txt，不要写在这里。",
  version: 1,
  owner: "auto",
  apiBase: "https://api.github.com",
  tokenEnv: ["GITHUB_TOKEN", "GH_TOKEN", "DSH_GITHUB_TOKEN"],
  tokenFile: "",
  visibility: "private",
  repoPrefix: "",
  pluginRoots: [],
  exclude: [],
  installRoot: "",
  profileDir: "",
  pnpmBin: "",
  maxFileMB: 20,
  branch: "main",
};

/* ───────────────── 基础工具 ───────────────── */

export function expandHome(p) {
  if (!p) return "";
  const s = String(p);
  if (s === "~") return homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(homedir(), s.slice(2));
  return s;
}

export const abs = (p) => (isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const kb = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);

export async function readJson(file) {
  try {
    let raw = await readFile(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return null; }
}

export async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function fileStamp(p) {
  try {
    const s = statSync(p);
    return { path: p, bytes: s.size, mtime: s.mtimeMs };
  } catch { return null; }
}

/* ───────────────── 配置 / 登记表 ───────────────── */

export function configDirOf(explicit) {
  const d = explicit || process.env.DSH_GH_UPLOAD_DIR || join(homedir(), ".dsh", "github-plugin-upload");
  return abs(expandHome(d));
}

export async function loadConfig(cfgDir) {
  const dir = configDirOf(cfgDir);
  const raw = (await readJson(join(dir, CONFIG_FILE))) || {};
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  if (!Array.isArray(cfg.tokenEnv)) cfg.tokenEnv = [...DEFAULT_CONFIG.tokenEnv];
  if (!Array.isArray(cfg.exclude)) cfg.exclude = [];
  if (!Array.isArray(cfg.pluginRoots)) cfg.pluginRoots = [];
  return { cfgDir: dir, cfg, raw };
}

export async function saveConfig(cfgDir, cfg) {
  const dir = configDirOf(cfgDir);
  await writeJson(join(dir, CONFIG_FILE), cfg);
  return join(dir, CONFIG_FILE);
}

export function maskToken(t) {
  if (!t) return "";
  return t.length <= 8 ? "***" : `${t.slice(0, 4)}…${t.slice(-4)} (len ${t.length})`;
}

/** 令牌解析顺序：显式参数 → 环境变量（config.tokenEnv）→ token.txt → config.token */
export async function resolveToken(cfgDir, cfg, explicit) {
  if (explicit) return { token: explicit, source: "参数" };
  for (const name of cfg.tokenEnv || []) {
    const v = process.env[name];
    if (v && v.trim()) return { token: v.trim(), source: `环境变量 ${name}` };
  }
  const tf = abs(expandHome(cfg.tokenFile || join(configDirOf(cfgDir), TOKEN_FILE)));
  try {
    const raw = (await readFile(tf, "utf8")).trim();
    if (raw) return { token: raw, source: `文件 ${tf}` };
  } catch { /* 没有 token.txt */ }
  if (cfg.token && String(cfg.token).trim()) return { token: String(cfg.token).trim(), source: "config.token（不推荐）" };
  return { token: "", source: "" };
}

export async function saveToken(cfgDir, token) {
  const file = join(configDirOf(cfgDir), TOKEN_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, String(token).trim() + "\n", { encoding: "utf8", mode: 0o600 });
  return file;
}

export async function loadRegistry(cfgDir) {
  const dir = configDirOf(cfgDir);
  const raw = (await readJson(join(dir, REGISTRY_FILE))) || {};
  return { version: 1, updatedAt: raw.updatedAt || "", repos: raw.repos && typeof raw.repos === "object" ? raw.repos : {} };
}

export async function saveRegistry(cfgDir, reg) {
  const dir = configDirOf(cfgDir);
  reg.updatedAt = new Date().toISOString();
  await writeJson(join(dir, REGISTRY_FILE), reg);
  return join(dir, REGISTRY_FILE);
}

/** 登记表键：优先仓库名（唯一），plugin 名兜底 */
export function findRecord(reg, key) {
  if (!key) return null;
  const k = String(key);
  if (reg.repos[k]) return [k, reg.repos[k]];
  for (const [name, rec] of Object.entries(reg.repos)) {
    if (rec.plugin === k || rec.folder === k || rec.repo === k) return [name, rec];
  }
  return null;
}

/* ───────────────── 插件识别 ───────────────── */

async function localeTitle(dir) {
  for (const f of ["zh-CN.json", "zh-Hans.json", "zh.json"]) {
    const data = await readJson(join(dir, "locale", f));
    const t = data && data.meta && data.meta.title;
    if (t) return String(t);
  }
  return "";
}

/**
 * 判断目录是否是一个 DSH 插件，是则返回信息，否则 null。
 * 判定：package.json + (cordis.patch.yml 或 package.json dsh.bundle.patch) + 入口文件。
 */
export async function pluginInfo(dir) {
  const absDir = abs(dir);
  const pkgFile = join(absDir, "package.json");
  if (!existsSync(pkgFile)) return null;
  const pkg = (await readJson(pkgFile)) || {};
  const patchFile = pkg?.dsh?.bundle?.patch ? abs(join(absDir, pkg.dsh.bundle.patch)) : join(absDir, "cordis.patch.yml");
  const hasPatch = existsSync(patchFile);
  const main = pkg.main || "./index.js";
  const hasEntry = existsSync(abs(join(absDir, main))) || existsSync(join(absDir, "index.js"));
  if (!hasPatch || !hasEntry) return null;
  const title = pkg.title || (await localeTitle(absDir)) || basename(absDir);
  return {
    dir: absDir,
    folder: basename(absDir),
    name: pkg.name || basename(absDir),
    version: pkg.version || "0.0.0",
    title: String(title),
    description: String(pkg.description || ""),
    main,
    patch: relative(absDir, patchFile).split(sep).join("/"),
    files: Array.isArray(pkg.files) ? pkg.files : [],
  };
}

/** 在若干根目录下扫描插件（根目录本身是插件也算，再往下找一层子目录） */
export async function scanRoots(roots) {
  const plugins = [];
  const errors = [];
  const seen = new Set();
  for (const root of roots) {
    const absRoot = abs(expandHome(root));
    if (!existsSync(absRoot)) { errors.push({ root: absRoot, error: "目录不存在" }); continue; }
    const self = await pluginInfo(absRoot).catch(() => null);
    if (self) { if (!seen.has(self.dir)) { seen.add(self.dir); plugins.push(self); } continue; }
    let entries = [];
    try { entries = await readdir(absRoot, { withFileTypes: true }); } catch (e) { errors.push({ root: absRoot, error: String(e.message) }); continue; }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name === "node_modules") continue;
      const child = join(absRoot, ent.name);
      try {
        const info = await pluginInfo(child);
        if (info && !seen.has(info.dir)) { seen.add(info.dir); plugins.push(info); }
      } catch (e) { errors.push({ dir: child, error: String(e.message) }); }
    }
  }
  plugins.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  return { plugins, errors };
}

/** 插件根目录候选（配置为空时自动探测） */
export function candidateRoots() {
  const list = [];
  const push = (p) => { if (!p) return; const v = abs(expandHome(p)); if (existsSync(v)) list.push(v); };
  if (process.env.DSH_GH_PLUGIN_ROOTS) {
    for (const p of String(process.env.DSH_GH_PLUGIN_ROOTS).split(delimiter)) push(p);
  }
  try { push(dirname(realpathSync(PLUGIN_DIR))); } catch { /* ignore */ }
  push("D:\\桌面\\ai插件");
  push(join(homedir(), "ai插件"));
  push(join(homedir(), "Documents", "ai插件"));
  const uniq = [...new Set(list)];
  return uniq;
}

export async function effectiveRoots(cfg) {
  if (cfg.pluginRoots && cfg.pluginRoots.length) return { roots: cfg.pluginRoots.map((p) => abs(expandHome(p))), auto: false };
  const cands = candidateRoots();
  for (const c of cands) {
    const r = await scanRoots([c]);
    if (r.plugins.length) return { roots: [c], auto: true };
  }
  return { roots: cands.slice(0, 1), auto: true };
}

export function installRootOf(cfg, roots) {
  if (cfg.installRoot) return abs(expandHome(cfg.installRoot));
  return roots && roots[0] ? roots[0] : join(homedir(), "ai插件");
}

/** GitHub 仓库名：只允许 ASCII 字母数字 . _ -，中文/空格一律转 - */
export function repoNameFor(plugin, cfg) {
  const raw = String(plugin.name || plugin.folder || "").trim();
  let s = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").replace(/-{2,}/g, "-");
  if (!s) s = "dsh-plugin";
  const prefix = String(cfg.repoPrefix || "").replace(/[^A-Za-z0-9._-]+/g, "-");
  s = (prefix ? prefix + "-" : "") + s;
  return s.slice(0, 90);
}

export function suggestOwner(cfg) {
  return cfg.owner && cfg.owner !== "auto" ? String(cfg.owner) : "";
}

/* ───────────────── 文件遍历 / git 摘要 ───────────────── */

export function gitBlobSha(buf) {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

const toPosix = (p) => p.split(sep).join("/");

/**
 * 遍历插件目录，产出待上传清单。
 * @returns {{files: Array<{rel:string,abs:string,size:number,sha:string,buf:Buffer|string,mode:string}>, skipped: Array<{rel:string,reason:string}>, bytes:number}}
 */
export async function walkFiles(root, opts = {}) {
  const excludes = new Set([...(opts.excludes || DEFAULT_EXCLUDES)].map((s) => s.toLowerCase()));
  const extra = new Set([...(opts.extraExcludes || [])].map((s) => s.toLowerCase()));
  const maxBytes = (opts.maxFileMB || 20) * 1024 * 1024;
  const files = [];
  const skipped = [];
  let bytes = 0;

  async function walk(dir) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { skipped.push({ rel: toPosix(relative(root, dir)) || ".", reason: "不可读：" + e.message }); return; }
    for (const ent of entries) {
      const absPath = join(dir, ent.name);
      const rel = toPosix(relative(root, absPath));
      const lower = ent.name.toLowerCase();
      if (ent.isSymbolicLink()) { skipped.push({ rel, reason: "符号链接（跳过）" }); continue; }
      if (ent.isDirectory()) {
        if (excludes.has(lower) || extra.has(lower)) { skipped.push({ rel: rel + "/", reason: "排除目录" }); continue; }
        await walk(absPath);
        continue;
      }
      if (!ent.isFile()) { skipped.push({ rel, reason: "非普通文件（跳过）" }); continue; }
      if (excludes.has(lower) || extra.has(lower)) { skipped.push({ rel, reason: "排除文件" }); continue; }
      let st;
      try { st = await stat(absPath); } catch { skipped.push({ rel, reason: "无法 stat" }); continue; }
      if (st.size > maxBytes) { skipped.push({ rel, reason: `超过 ${opts.maxFileMB || 20}MB（${kb(st.size)}）` }); continue; }
      let buf;
      try { buf = await readFile(absPath); } catch (e) { skipped.push({ rel, reason: "读失败：" + e.message }); continue; }
      const exec = process.platform !== "win32" && (st.mode & 0o111) !== 0;
      files.push({ rel, abs: absPath, size: buf.length, sha: gitBlobSha(buf), buf, mode: exec ? "100755" : "100644" });
      bytes += buf.length;
    }
  }
  await walk(root);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, skipped, bytes };
}

export function treeIdOf(files) {
  const h = createHash("sha1");
  for (const f of files) h.update(`${f.rel}\0${f.sha}\0${f.mode}\0`);
  return h.digest("hex");
}

/* ───────────────── GitHub REST 客户端 ───────────────── */

export class ApiError extends Error {
  constructor(message, status, data, path) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.path = path;
  }
}

export function makeApi({ token, apiBase = "https://api.github.com", userAgent = "dsh-github-upload/1.0", timeoutMs = 45000, onLog } = {}) {
  const base = String(apiBase || "https://api.github.com").replace(/\/+$/, "");

  async function request(method, path, body, opts = {}) {
    const url = path.startsWith("http") ? path : base + path;
    const headers = {
      "user-agent": userAgent,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (body !== undefined && body !== null) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const attempts = opts.retries === undefined ? 2 : opts.retries;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (attempt < attempts) { await sleep(800 * (attempt + 1)); continue; }
        throw new ApiError(`网络错误（${method} ${path}）：${e.message || e}`, 0, null, path);
      }
      const text = await res.text().catch(() => "");
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
      if (res.ok) return { status: res.status, data, headers: res.headers };

      if (res.status === 404 && opts.allow404) return { status: 404, data, notFound: true };
      if (res.status === 409 && opts.allowEmpty) return { status: 409, data, notFound: true };

      const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504
        || (res.status === 403 && /rate limit|abuse/i.test(String(msg)));
      if (retryable && attempt < attempts) {
        const wait = 1000 * Math.pow(2, attempt);
        if (onLog) onLog(`   ⟳ ${res.status} 重试（${wait}ms）：${msg}`);
        await sleep(wait);
        continue;
      }
      throw new ApiError(`${method} ${path} 失败（${res.status}）：${msg}`, res.status, data, path);
    }
  }

  return {
    token,
    base,
    request,
    get: (p, o) => request("GET", p, null, o),
    post: (p, b, o) => request("POST", p, b, o),
    patch: (p, b, o) => request("PATCH", p, b, o),
    put: (p, b, o) => request("PUT", p, b, o),
    del: (p, b, o) => request("DELETE", p, b, o),
  };
}

/** 令牌自检：返回登录名与可见 scopes */
export async function whoAmI(api) {
  const r = await api.get("/user");
  const scopeHeader = r.headers && (r.headers.get ? r.headers.get("x-oauth-scopes") : r.headers["x-oauth-scopes"]);
  return {
    login: r.data?.login || "",
    name: r.data?.name || "",
    scopes: scopeHeader ? String(scopeHeader).split(",").map((s) => s.trim()).filter(Boolean) : [],
    type: r.data?.type || "",
    privateRepos: r.data?.total_private_repos ?? null,
  };
}

/** 仓库名 → 完整仓库信息（404 返回 null） */
export async function getRepo(api, owner, repo) {
  const r = await api.get(`/repos/${owner}/${repo}`, { allow404: true });
  return r.notFound ? null : r.data;
}

/**
 * 建私有库。
 * autoInit 默认 true：GitHub 对「完全没有提交的空库」会拒绝 blobs/trees 接口（409 Git Repository is empty），
 * 所以建库时顺手带一个初始提交，后续就能正常走 Git Data API。
 */
export async function createPrivateRepo(api, owner, repo, { description = "", autoInit = true } = {}) {
  const body = {
    name: repo, private: true, auto_init: !!autoInit, description: description.slice(0, 350),
    has_issues: false, has_wiki: false, has_projects: false,
  };
  let r;
  if (!owner) r = await api.post("/user/repos", body);
  else r = await api.post(`/orgs/${owner}/repos`, body, { allow404: true });
  if (r && r.notFound) r = await api.post("/user/repos", body);
  return r.data;
}

/** 兜底：已存在的空库（没有初始提交）先用 Contents API 写一个文件，把它变成「有提交的库」 */
export async function initEmptyRepo(api, owner, repo, branch, filePath, content) {
  await api.put(`/repos/${owner}/${repo}/contents/${filePath}`, {
    message: "chore(dsh): 初始化仓库",
    content: Buffer.from(content).toString("base64"),
    branch,
  });
}

/** 读取分支头（空库返回 { empty: true }） */
export async function getHead(api, owner, repo, branch) {
  const ref = await api.request("GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`, null, { allow404: true, allowEmpty: true });
  if (ref.notFound) return { empty: true };
  const sha = ref.data?.object?.sha;
  if (!sha) return { empty: true };
  const commit = await api.get(`/repos/${owner}/${repo}/git/commits/${sha}`);
  const treeSha = commit.data?.tree?.sha;
  let entries = new Map();
  let truncated = false;
  if (treeSha) {
    const tree = await api.get(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
    truncated = !!tree.data?.truncated;
    for (const e of tree.data?.tree || []) {
      if (e.type === "blob") entries.set(e.path, e.sha);
    }
  }
  return { empty: false, sha, treeSha, entries, truncated, message: commit.data?.commit?.message || "" };
}

/** 组装 DSH 插件仓库的 README（插件自己没有 README.md 时补一份，便于以后安装） */
export function readmeFor(plugin, owner, repo) {
  const title = plugin.title ? `${plugin.title}（${plugin.name}）` : plugin.name;
  return [
    `# ${title}`,
    "",
    plugin.description ? `> ${plugin.description}` : "",
    "",
    `- 版本：v${plugin.version}`,
    `- 包名：\`${plugin.name}\``,
    `- 类型：DSH 插件（Cordis 工具插件，一个插件一个库）`,
    "",
    "## 安装（DSH）",
    "",
    "```powershell",
    "# 私有库需要令牌；把 <TOKEN> 换成你的 PAT（repo 权限）",
    `git clone https://x-access-token@github.com/${owner}/${repo}.git "$HOME\\ai插件\\${plugin.folder || plugin.name}"`,
    "# 然后把这个目录 link 进 DSH profile：",
    `#   dependencies["${plugin.name}"] = "link:<上面的目录>"`,
    `#   dsh.profile.bundles += "${plugin.name}"`,
    "```",
    "",
    "或者直接用 DSH 里的 `github_upload` 工具：",
    "",
    "```json",
    `{"action":"install","repo":"${owner}/${repo}"}`,
    "```",
    "",
    "---",
    "",
    "本仓库由 DSH 插件「GitHub插件自动上传」自动同步，请以源目录为准。",
    "",
  ].filter((l) => l !== undefined).join("\n");
}

/* ───────────────── 自测用：JSON Schema 子集校验 ───────────────── */

/** 校验工具输出是否符合 output.schema（type / required / properties / additionalProperties / items / enum） */
export function validateAgainstSchema(schema, value, path = "$") {
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} 不在 enum 里`);
  const t = schema.type;
  if (t) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const checkers = {
      integer: (v) => typeof v === "number" && Number.isInteger(v),
      number: (v) => typeof v === "number" && Number.isFinite(v),
      object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
      array: Array.isArray,
      string: (v) => typeof v === "string",
      boolean: (v) => typeof v === "boolean",
      null: (v) => v === null,
    };
    const ok = checkers[t] ? checkers[t](value) : actual === t;
    if (!ok) errors.push(`${path}: 期望 ${t}，实际 ${actual}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...validateAgainstSchema(schema.items, v, `${path}[${i}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}: 缺必填字段 ${k}`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties && schema.properties[k];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push(`${path}: 多余字段 ${k}`);
        continue;
      }
      errors.push(...validateAgainstSchema(sub, v, `${path}.${k}`));
    }
  }
  return errors;
}

/* ───────────────── DSH profile 挂载（link 进 profile） ───────────────── */

/** 跑一条命令（收输出；令牌等敏感值只走 env） */
export function runCommand(cmd, args, { cwd, env, timeoutMs = 300000, windowsHide = true, shell = false } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    let out = "";
    let err = "";
    let settled = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, windowsHide, shell });
    } catch (e) {
      done({ ok: false, code: null, ms: 0, out: "", err: String(e.message || e) });
      return;
    }
    const finish = (ok, code, extra) => {
      if (settled) return;
      settled = true;
      done({ ok, code, ms: Date.now() - t0, out, err: err + (extra || "") });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish(false, null, `\n[timeout ${timeoutMs}ms]`);
    }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("error", (e) => { clearTimeout(timer); finish(false, null, "\n" + String(e.message || e)); });
    child.on("close", (code) => { clearTimeout(timer); finish(code === 0, code); });
  });
}

function electronResourcesDir() {
  if (typeof process.resourcesPath === "string" && process.resourcesPath && existsSync(process.resourcesPath)) return process.resourcesPath;
  const exeDir = process.execPath ? dirname(process.execPath) : "";
  for (const cand of [join(exeDir, "resources"), join(exeDir, "..", "Resources")]) {
    if (cand && existsSync(cand)) return cand;
  }
  return "";
}

/** 找 DSH 的 profile 目录（默认 desktop） */
export async function findProfileDir(cfg, override) {
  const explicit = override || (cfg && cfg.profileDir);
  if (explicit) {
    const p = abs(expandHome(explicit));
    return existsSync(join(p, "package.json")) ? p : "";
  }
  const base = join(homedir(), ".dsh", "profiles");
  const names = [];
  try {
    for (const e of await readdir(base, { withFileTypes: true })) if (e.isDirectory()) names.push(e.name);
  } catch { /* 没有 profiles 目录 */ }
  for (const n of ["desktop", ...names.filter((x) => x !== "desktop")]) {
    const p = join(base, n);
    if (existsSync(join(p, "package.json"))) return p;
  }
  return "";
}

/** 找 pnpm：配置 → 环境变量 → DSH 自带（Electron resources）→ PATH */
export function findPnpm(cfg) {
  const tries = [];
  const push = (p) => { if (p) tries.push(String(p)); };
  push(cfg && cfg.pnpmBin ? abs(expandHome(cfg.pnpmBin)) : "");
  push(process.env.DSH_PNPM_BIN);
  const resDirs = [process.env.DSH_RESOURCES_PATH, electronResourcesDir()].filter(Boolean);
  for (const res of resDirs) {
    const root = join(res, "runtime", "primary-runtime", "dependencies", "pnpm");
    push(join(root, "bin", "pnpm.cjs"));
    push(join(root, "pnpm.cjs"));
    push(join(root, "bin", "pnpm.mjs"));
    push(join(root, "dist", "pnpm.mjs"));
  }
  for (const t of tries) {
    if (existsSync(t)) return { kind: /\.(c|m)?js$/i.test(t) ? "cjs" : "bin", path: t };
  }
  try {
    const r = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["pnpm"], { encoding: "utf8", windowsHide: true });
    const p = String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (r.status === 0 && p) return { kind: "bin", path: p };
  } catch { /* 没有 pnpm */ }
  return null;
}

/**
 * 把一个插件目录 link 进 DSH profile：
 *   dependencies[包名] = link:<目录>  +  dsh.profile.bundles 追加包名  → 跑 pnpm install
 * 改的是 profile 的 package.json（DSH 重启后生效）。
 */
export async function linkPluginToProfile(cfg, dir, opts = {}) {
  const info = await pluginInfo(dir);
  if (!info) return { ok: false, error: "目录不是 DSH 插件（缺 package.json / cordis.patch.yml / index.js）" };
  const profileDir = await findProfileDir(cfg, opts.profileDir);
  if (!profileDir) return { ok: false, error: "找不到 DSH profile 目录（可用 profileDir 指定，例如 C:\\Users\\<你>\\.dsh\\profiles\\desktop）" };

  const pkgFile = join(profileDir, "package.json");
  const pkg = (await readJson(pkgFile)) || {};
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
  const target = "link:" + abs(dir).split(sep).join("/");
  const changedDep = pkg.dependencies[info.name] !== target;
  pkg.dependencies[info.name] = target;
  pkg.dsh = pkg.dsh && typeof pkg.dsh === "object" ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === "object" ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  const bundleAdded = !bundles.includes(info.name);
  if (bundleAdded) bundles.push(info.name);
  pkg.dsh.profile.bundles = bundles;
  await writeJson(pkgFile, pkg);

  const manual = `cd "${profileDir}"; pnpm install`;
  const pnpm = findPnpm(cfg);
  const base = { ok: true, profileDir, plugin: info.name, link: target, changedDep, bundleAdded, needsRestart: true, command: manual };
  if (!pnpm) return { ...base, needsManual: true, pnpm: "", note: "没找到 pnpm，已改好 profile/package.json，请手动执行：" + manual };
  if (opts.noInstall) return { ...base, needsManual: true, pnpm: pnpm.path, note: "已改好 profile/package.json（noInstall），需要执行：" + manual };

  let r;
  if (pnpm.kind === "cjs") r = await runCommand(process.execPath, [pnpm.path, "install"], { cwd: profileDir, env: { CI: "1" } });
  else if (process.platform === "win32" && /\.(cmd|bat)$/i.test(pnpm.path)) r = await runCommand(`"${pnpm.path}" install`, [], { cwd: profileDir, env: { CI: "1" }, shell: true });
  else r = await runCommand(pnpm.path, ["install"], { cwd: profileDir, env: { CI: "1" } });
  const tailTxt = String((r.err || "") + (r.out || "")).trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
  return {
    ...base,
    ok: r.ok,
    needsManual: !r.ok,
    pnpm: pnpm.path,
    ms: r.ms,
    tail: tailTxt,
    error: r.ok ? "" : `pnpm install 失败，请手动执行：${manual}\n${tailTxt}`,
  };
}

