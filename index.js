// github_upload — 「GitHub插件自动上传」DSH 插件
//
// 一个插件一个私有库：把 D:\桌面\ai插件 下的 DSH 插件（现有的 / 新做好的）自动同步到 GitHub 私有仓库，
// 以后换机器或重装 DSH，用 action=install 就能把插件装回来。
//
// 动作：
//   status   自检：令牌、账号、插件目录、已上传数量、待同步数量
//   init     初始化配置（自动探测插件根目录 / profile / pnpm）
//   login    设备码登录 GitHub（OAuth App device flow，不需要 client secret）
//   login-status / login-cancel / logout  登录态、取消、退出
//   auth     校验并保存 GitHub 令牌（PAT，需 repo 权限；设备码不可用时的兜底）
//   scan     扫描插件，算出建议仓库名与文件清单（只读、不联网）
//   push     上传：单插件 / 多个 / all=true 全量增量同步（无改动自动跳过）
//   install  从私有库装回插件（可 link 进 DSH profile）
//   link     把已有插件目录挂进 DSH profile（改 package.json + pnpm install）
//   list     列出登记表里的插件仓库
//
// 上传走 GitHub REST Git Data API（blobs → tree → commit → ref），不写 .git、不动工作区、
// 只传变动的文件；删除的文件会自动从远端树里去掉。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  candidateRoots, configDirOf, effectiveRoots, findProfileDir, findPnpm, kb, linkPluginToProfile, loadConfig,
  loadRegistry, makeApi, maskToken, pluginInfo, repoNameFor, resolveToken, runCommand, saveConfig, saveToken, scanRoots,
  treeIdOf, walkFiles, whoAmI,
} from "./assets/lib.mjs";
import { cancelLogin, disposeLogin, loginStatus, logout, startLogin } from "./gate.js";

export const name = "github-plugin-upload";
export const inject = ["tools", "webServer"];

/** 设置页用到的 HTTP 路由前缀（登录卡片的宿主半边）。 */
const ROUTE = "/dsh-github-gate";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "assets");
const DEFAULT_CFG_DIR = configDirOf("");

/** 跑 assets 里的脚本，取它的 JSON 输出 */
function runScript(file, args, { timeoutMs = 15 * 60 * 1000, cfgDir, extraEnv } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    let out = "";
    let err = "";
    let settled = false;
    const env = { ...process.env, ...(extraEnv || {}) };
    if (typeof process.resourcesPath === "string" && process.resourcesPath) env.DSH_RESOURCES_PATH = process.resourcesPath;
    if (cfgDir) env.DSH_GH_UPLOAD_DIR = cfgDir;
    const child = spawn(process.execPath, [join(ASSETS, file), ...args], { cwd: HERE, env, windowsHide: true, shell: false });
    const finish = (ok, code, extra) => {
      if (settled) return;
      settled = true;
      done({ ok, code, ms: Date.now() - t0, out, err: err + (extra || ""), json: extractJson(out) });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish(false, null, `\n[timeout ${timeoutMs}ms]`);
    }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("error", (e) => { clearTimeout(timer); finish(false, null, "\n" + String(e && e.message)); });
    child.on("close", (code) => { clearTimeout(timer); finish(code === 0, code); });
  });
}

/** 从输出里取第一个完整 JSON 对象 */
function extractJson(text) {
  const s = String(text || "");
  const i = s.indexOf("{");
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { try { return JSON.parse(s.slice(i, k + 1)); } catch { return null; } }
    }
  }
  return null;
}

const tail = (s, n = 12) => String(s || "").trim().split(/\r?\n/).slice(-n).join("\n");

function step(name, ok, ms, text) {
  return { name, ok: !!ok, ms: Math.max(0, Math.round(ms || 0)), tail: String(text || "").slice(0, 4000) };
}

/** 参数里的临时令牌：只在本次调用生效，并让子进程能读到 */
function tokenEnv(token) {
  return token ? { DSH_GITHUB_TOKEN: String(token), GITHUB_TOKEN: String(token) } : {};
}

/* ───────────────── status ───────────────── */

async function doStatus(cfgDirArg, probe = true) {
  const { cfgDir, cfg } = await loadConfig(cfgDirArg);
  const reg = await loadRegistry(cfgDir);
  const t = await resolveToken(cfgDir, cfg);
  const roots = await effectiveRoots(cfg);
  const scanned = await scanRoots(roots.roots);
  const checks = [];
  const issues = [];
  const hasConfig = existsSync(join(cfgDir, "config.json"));

  checks.push({ name: "配置文件", ok: hasConfig, detail: `${join(cfgDir, "config.json")}${hasConfig ? "" : "（未初始化：action=init 生成）"}` });

  if (!t.token) {
    checks.push({ name: "令牌", ok: false, detail: "未配置：action=auth token=ghp_xxx，或设环境变量 GITHUB_TOKEN" });
    issues.push({ level: "warn", msg: "没有令牌，只能 scan / list，不能 push / install" });
  } else {
    let detail = `${maskToken(t.token)}（来自 ${t.source}）`;
    if (probe) {
      try {
        const me = await whoAmI(makeApi({ token: t.token, apiBase: cfg.apiBase, timeoutMs: 12000 }));
        detail += ` · @${me.login}${me.scopes.length ? " · scopes " + me.scopes.join(",") : ""}`;
        checks.push({ name: "令牌", ok: true, detail });
      } catch (e) {
        checks.push({ name: "令牌", ok: false, detail: `${detail} · 校验失败：${String(e.message || e)}` });
        issues.push({ level: "error", msg: "令牌校验失败：换一个新 PAT（classic 勾 repo）后 action=auth" });
      }
    } else {
      checks.push({ name: "令牌", ok: true, detail });
    }
  }

  checks.push({ name: "账号 / 可见性", ok: true, detail: `owner=${cfg.owner || "auto"} · ${cfg.visibility || "private"} · 前缀「${cfg.repoPrefix || "无"}」` });
  checks.push({ name: "插件根目录", ok: roots.roots.length > 0, detail: `${roots.roots.join(" · ") || "未探测到"}${roots.auto ? "（自动探测）" : "（来自配置）"}` });
  checks.push({ name: "插件", ok: scanned.plugins.length > 0, detail: `${scanned.plugins.length} 个：${scanned.plugins.map((p) => p.title).join("、") || "无"}` });
  checks.push({ name: "登记表", ok: true, detail: `${Object.keys(reg.repos).length} 个仓库 · ${join(cfgDir, "registry.json")}` });

  // 待同步统计（只算本地 treeId 差异，不联网）
  let pending = 0;
  const rows = [];
  for (const p of scanned.plugins) {
    const repo = repoNameFor(p, cfg);
    const rec = reg.repos[repo];
    const w = await walkFiles(p.dir, { extraExcludes: cfg.exclude, maxFileMB: cfg.maxFileMB });
    const dirty = !rec || treeIdOf(w.files) !== rec.treeId;
    if (dirty) pending++;
    rows.push({
      name: p.name, title: p.title, version: p.version, repo: `${rec?.owner || cfg.owner}/${repo}`,
      repoUrl: rec?.repoUrl || "", status: !rec ? "new" : dirty ? "dirty" : "synced",
      files: w.files.length, bytes: w.bytes, changed: dirty, sha: rec?.sha || "", dir: p.dir,
    });
  }
  checks.push({ name: "待同步", ok: pending === 0, detail: pending ? `${pending} 个插件有改动或未建库` : "全部已同步" });

  const pnpm = findPnpm(cfg);
  const profileDir = await findProfileDir(cfg);
  checks.push({ name: "DSH profile", ok: !!profileDir, detail: `${profileDir || "未找到"}${pnpm ? " · pnpm 就绪" : " · 未找到 pnpm（link 需手动 pnpm install）"}` });

  const ok = !issues.some((i) => i.level === "error");
  const summary = `${scanned.plugins.length} 个插件 · 已上传 ${Object.keys(reg.repos).length} · 待同步 ${pending}`
    + (t.token ? "" : " · 缺令牌");
  return { ok, checks, issues, summary, cfgDir, plugins: rows, pending };
}

/* ───────────────── init ───────────────── */

async function doInit(cfgDirArg, args) {
  const cfgDir = configDirOf(cfgDirArg);
  const { cfg, raw } = await loadConfig(cfgDir);
  const next = { ...cfg };
  if (!raw || !raw.version) {
    // 首次初始化：把探测结果写进配置，省得以后再猜
    const cands = candidateRoots();
    let roots = [];
    for (const c of cands) {
      const r = await scanRoots([c]);
      if (r.plugins.length) { roots = [c]; break; }
    }
    if (args.roots && args.roots.length) roots = args.roots.map((p) => resolve(String(p)));
    next.pluginRoots = roots;
    next.installRoot = roots[0] || join(DEFAULT_CFG_DIR, "无");
    const prof = await findProfileDir(next);
    if (prof) next.profileDir = prof;
    const pnpm = findPnpm(next);
    if (pnpm) next.pnpmBin = pnpm.path;
  }
  if (args.owner) next.owner = args.owner;
  if (args.clientId) next.oauthClientId = String(args.clientId).trim();
  if (args.scope) next.oauthScope = String(args.scope).trim();
  if (args.repoPrefix !== undefined) next.repoPrefix = args.repoPrefix;
  const file = await saveConfig(cfgDir, next);
  return {
    ok: true,
    cfgDir,
    checks: [
      { name: "配置文件", ok: true, detail: file },
      { name: "插件根目录", ok: next.pluginRoots.length > 0, detail: next.pluginRoots.join(" · ") || "未探测到（在 config.json 里填 pluginRoots）" },
      { name: "安装目录", ok: true, detail: next.installRoot || "(空)" },
      { name: "profile", ok: !!next.profileDir, detail: next.profileDir || "未找到（link 时可用 profileDir 指定）" },
      { name: "pnpm", ok: !!next.pnpmBin, detail: next.pnpmBin || "未找到（link 时可手动 pnpm install）" },
      next.oauthClientId
        ? { name: "OAuth App", ok: true, detail: `client_id 已配置 · scope ${next.oauthScope || "repo"} · 可用 action=login 登录` }
        : { name: "OAuth App", ok: false, detail: "未配置 clientId（可选）：不配也能用，登录改走 action=auth token=<PAT>" },
      { name: "令牌", ok: false, detail: "下一步：action=login（设备码登录）或 action=auth token=<PAT>" },
    ],
    summary: `配置已写入 ${file}`,
  };
}

/* ───────────────── auth ───────────────── */

async function doAuth(cfgDirArg, args) {
  const { cfgDir, cfg } = await loadConfig(cfgDirArg);
  const t = await resolveToken(cfgDir, cfg, args.token);
  if (!t.token) {
    return { ok: false, summary: "没有令牌：请把 PAT 作为 token 传入（或设环境变量 GITHUB_TOKEN）", checks: [], issues: [{ level: "error", msg: "缺少 token 参数" }] };
  }
  const api = makeApi({ token: t.token, apiBase: cfg.apiBase, timeoutMs: 15000 });
  const me = await whoAmI(api);
  const checks = [
    { name: "账号", ok: true, detail: `@${me.login}${me.name ? "（" + me.name + "）" : ""}` },
    {
      name: "权限", ok: me.scopes.length === 0 ? true : me.scopes.includes("repo") || me.scopes.includes("public_repo"),
      detail: me.scopes.length ? `scopes: ${me.scopes.join(", ")}${me.scopes.includes("repo") ? "（够用）" : "（建私有库需要 repo）"}` : "fine-grained 令牌看不到 scopes，需确认 Administration + Contents 为 Read/Write",
    },
    { name: "私有库数", ok: true, detail: me.privateRepos === null ? "(不可见)" : String(me.privateRepos) },
  ];
  let saved = "";
  if (args.saveToken !== false) saved = await saveToken(cfgDir, t.token);
  return {
    ok: true,
    checks,
    summary: `令牌可用：@${me.login}${saved ? " · 已保存到 " + saved : " · 未保存（saveToken=false）"}`,
  };
}

/* ───────────────── scan / push / install ───────────────── */

async function doScan(cfgDirArg, args) {
  const list = ["--json"];
  if (cfgDirArg) list.push("--config", cfgDirArg);
  if (args.dir) list.push("--dir", resolve(String(args.dir)));
  if (args.roots && args.roots.length) list.push("--roots", args.roots.join(";"));
  const r = await runScript("scan.mjs", list, { cfgDir: cfgDirArg, timeoutMs: 5 * 60 * 1000 });
  const data = r.json;
  const plugins = (data?.plugins || []).map((p) => ({
    name: p.name, title: p.title, version: p.version, repo: p.repo, repoUrl: p.repoUrl || "",
    status: p.error ? "error" : !p.uploaded ? "new" : p.changed ? "dirty" : "synced",
    files: p.files, bytes: p.bytes, changed: !!p.changed, dir: p.dir, error: p.error || "",
  }));
  return {
    ok: r.ok && !!data,
    plugins,
    checks: data?.roots ? [{ name: "扫描根", ok: true, detail: `${data.roots.join(" · ")}${data.autoRoots ? "（自动探测）" : ""}` }] : [],
    issues: (data?.errors || []).map((e) => ({ level: "warn", msg: `${e.root || e.dir}：${e.error}` })),
    steps: [step("scan", r.ok, r.ms, data ? "" : tail(r.err || r.out, 8))],
    summary: data ? `${plugins.length} 个插件 · 未建库 ${plugins.filter((p) => p.status === "new").length} · 待同步 ${plugins.filter((p) => p.status === "dirty").length}` : "扫描失败",
  };
}

async function doPush(cfgDirArg, args) {
  const list = ["--json"];
  if (cfgDirArg) list.push("--config", cfgDirArg);
  if (args.dir) list.push("--dir", resolve(String(args.dir)));
  if (args.dirs && args.dirs.length) list.push("--dirs", args.dirs.join(";"));
  if (args.all) list.push("--all");
  if (args.force) list.push("--force");
  if (args.dryRun) list.push("--dry-run");
  if (args.owner) list.push("--owner", String(args.owner));
  if (args.repoPrefix !== undefined) list.push("--repo-prefix", String(args.repoPrefix));
  if (args.message) list.push("--message", String(args.message));
  if (args.maxFileMB) list.push("--max-file-mb", String(args.maxFileMB));
  if (args.allowPublic) list.push("--allow-public");
  else {
    // 有些库本身就是「故意公开」的（比如门房自己、给用户的引导库）。
    // 把它们的仓库名写进 config.publicRepos，就不必每次手动传 allowPublic=true。
    try {
      const { cfg } = await loadConfig(cfgDirArg);
      const allowed = Array.isArray(cfg.publicRepos) ? cfg.publicRepos : [];
      const dirs = [];
      if (args.dir) dirs.push(resolve(String(args.dir)));
      if (Array.isArray(args.dirs)) dirs.push(...args.dirs.map((value) => resolve(String(value))));
      for (const dir of dirs) {
        const info = await pluginInfo(dir);
        if (info && allowed.includes(repoNameFor(info, cfg))) {
          list.push("--allow-public");
          break;
        }
      }
    } catch {
      /* 判不出来就按默认（要求私有）处理，让 push.mjs 自己去拒 */
    }
  }
  const r = await runScript("push.mjs", list, { cfgDir: cfgDirArg, extraEnv: tokenEnv(args.token), timeoutMs: 20 * 60 * 1000 });
  const data = r.json;
  const plugins = (data?.plugins || []).map((p) => ({
    name: p.name, title: p.title, version: p.version, repo: p.repo, repoUrl: p.repoUrl || "",
    status: p.error ? "failed" : p.nochange ? "unchanged" : p.newRepo ? "created" : "pushed",
    files: p.files || 0, bytes: p.bytes || 0, changed: !p.nochange && !p.error,
    uploaded: p.uploaded || 0, deleted: p.deleted || 0, sha: p.sha || "", dir: p.dir || "", error: p.error || "",
  }));
  const issues = [
    ...(data?.errors || []).map((e) => ({ level: "error", msg: `${e.msg}${e.hint ? "（" + e.hint + "）" : ""}` })),
    ...(data?.plugins || []).filter((p) => p.skipped && p.skipped.length).flatMap((p) => p.skipped.slice(0, 3).map((s) => ({ level: "info", msg: `${p.title}：跳过 ${s}` }))),
  ];
  return {
    ok: r.ok && !!data && !!data.ok,
    plugins,
    issues,
    stats: data?.stats,
    steps: [step("push", r.ok, r.ms, data ? "" : tail(r.err || r.out, 10))],
    summary: data ? data.summary : "上传失败：" + tail(r.err || r.out, 6),
  };
}

async function doInstall(cfgDirArg, args) {
  const list = ["--json"];
  if (cfgDirArg) list.push("--config", cfgDirArg);
  if (args.repo) list.push("--repo", String(args.repo));
  if (args.name) list.push("--name", String(args.name));
  if (args.all) list.push("--all");
  if (args.into) list.push("--into", resolve(String(args.into)));
  if (args.force) list.push("--force");
  if (args.link) list.push("--link");
  if (args.profileDir) list.push("--profile", resolve(String(args.profileDir)));
  const r = await runScript("install.mjs", list, { cfgDir: cfgDirArg, extraEnv: tokenEnv(args.token), timeoutMs: 10 * 60 * 1000 });
  const data = r.json;
  const plugins = (data?.repos || []).map((p) => ({
    name: p.plugin || "", title: p.title || p.plugin || "", version: p.version || "",
    repo: String(p.key || ""), repoUrl: "", dir: p.dir || "",
    status: p.ok ? (p.skipped ? "unchanged" : "installed") : "failed",
    error: p.ok ? "" : String(p.log || ""),
  }));
  return {
    ok: r.ok && !!data && !!data.ok,
    plugins,
    steps: [step("install", r.ok, r.ms, data ? "" : tail(r.err || r.out, 10))],
    summary: data ? data.summary + (data.installRoot ? ` · ${data.installRoot}` : "") : "安装失败：" + tail(r.err || r.out, 6),
  };
}

/* ───────────────── link ───────────────── */

async function doLink(cfgDirArg, args) {
  if (!args.dir) return { ok: false, summary: "link 需要 dir（要挂进 DSH 的插件目录）", checks: [] };
  const { cfg } = await loadConfig(cfgDirArg);
  const dir = resolve(String(args.dir));
  const info = await pluginInfo(dir);
  if (!info) return { ok: false, summary: `${dir} 不是 DSH 插件`, checks: [] };
  const r = await linkPluginToProfile(cfg, dir, { profileDir: args.profileDir ? resolve(String(args.profileDir)) : "", pnpmBin: cfg.pnpmBin, noInstall: !!args.noInstall });
  const checks = [
    { name: "插件", ok: true, detail: `${info.title}（${info.name}）v${info.version}` },
    { name: "profile", ok: !!r.profileDir, detail: r.profileDir || r.error || "" },
    { name: "package.json", ok: !!r.profileDir, detail: r.link ? `dependencies["${info.name}"] = ${r.link}${r.bundleAdded ? " · 已加入 bundles" : ""}` : "" },
    { name: "pnpm install", ok: !!r.ok && !r.needsManual, detail: r.needsManual ? r.error || r.note || "需手动执行" : `完成（${((r.ms || 0) / 1000).toFixed(1)}s）` },
  ];
  return {
    ok: !!r.ok,
    checks,
    issues: r.ok ? [{ level: "info", msg: "重启 DSH 后新插件生效" }] : [{ level: "error", msg: r.error || r.note || "link 失败" }],
    summary: r.ok ? (r.needsManual ? "已改好 profile，还需手动 pnpm install" : "已 link 进 DSH profile，重启后生效") : "link 失败",
  };
}

/* ───────────────── list ───────────────── */

async function doList(cfgDirArg, args) {
  const { cfg } = await loadConfig(cfgDirArg);
  const reg = await loadRegistry(configDirOf(cfgDirArg));
  const entries = Object.entries(reg.repos);
  let remote = null;
  if (args.refresh && entries.length) {
    try {
      const t = await resolveToken(configDirOf(cfgDirArg), cfg, args.token);
      if (t.token) {
        const api = makeApi({ token: t.token, apiBase: cfg.apiBase, timeoutMs: 15000 });
        remote = { api, me: await whoAmI(api) };
      }
    } catch { remote = null; }
  }
  const plugins = [];
  for (const [repo, rec] of entries) {
    let status = "uploaded";
    if (remote) {
      try {
        const r = await remote.api.get(`/repos/${rec.owner}/${rec.repo}`, { allow404: true });
        if (r.notFound) status = "missing";
        else status = "uploaded";
      } catch { status = "unknown"; }
    }
    plugins.push({
      name: rec.plugin || repo, title: rec.title || repo, version: rec.packageVersion || "",
      repo: `${rec.owner}/${rec.repo}`, repoUrl: rec.repoUrl || "", status,
      files: rec.files || 0, bytes: rec.bytes || 0, changed: false, sha: rec.sha || "", dir: rec.dir || "",
    });
  }
  return {
    ok: true,
    plugins,
    checks: [{ name: "登记表", ok: true, detail: `${entries.length} 个仓库 · ${reg.updatedAt || "—"}` }],
    summary: entries.length ? `已上传 ${entries.length} 个插件仓库` : "登记表为空：先 action=scan，再 action=push all=true",
  };
}

/* ───────────────── download（不吃 git 的拉取） ───────────────── */

/**
 * 用 GitHub tarball 把仓库拉成本地目录，再可选 link 进 profile。
 *
 * 存在的理由：install.mjs 走的是 `git clone`，而「新机器第一次恢复」的机器
 * 往往没装 git。tarball 只要一个令牌就能下，Windows 自带 bsdtar 就能解。
 */
async function downloadOne({ api, owner, repo, dir, link, profileDir, cfg }) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/tarball/HEAD`, {
    headers: { authorization: `Bearer ${api.token}`, accept: "application/vnd.github+json", "user-agent": "dsh-github-upload/1.1" },
  });
  if (!response.ok) return { ok: false, dir, error: `下载失败 HTTP ${response.status}` };
  const buffer = Buffer.from(await response.arrayBuffer());
  const { tmpdir } = await import("node:os");
  const { writeFile, mkdir, rm } = await import("node:fs/promises");
  const tmp = join(tmpdir(), `github-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`);
  await writeFile(tmp, buffer);
  await mkdir(dir, { recursive: true });
  const tar = await runCommand("tar", ["-xzf", tmp, "-C", dir, "--strip-components=1"], { timeoutMs: 180000 });
  await rm(tmp, { force: true }).catch(() => undefined);
  if (!tar.ok) return { ok: false, dir, error: `解压失败：${(tar.text || "").slice(-300)}` };
  if (link !== true) return { ok: true, dir, bytes: buffer.length, linked: false };
  const linked = await linkPluginToProfile(cfg, dir, { profileDir: profileDir || cfg.profileDir || "", pnpmBin: cfg.pnpmBin });
  return { ok: linked.ok === true, dir, bytes: buffer.length, linked: linked.ok === true, linkError: linked.ok ? "" : (linked.error || linked.note || "") };
}

async function doDownload(cfgDirArg, args) {
  const { cfgDir, cfg } = await loadConfig(cfgDirArg);
  const reg = await loadRegistry(cfgDir);
  const t = await resolveToken(cfgDir, cfg, args.token);
  if (!t.token) return { ok: false, summary: "没有令牌：先 action=login（设备码）或 action=auth token=<PAT>", checks: [] };
  const api = makeApi({ token: t.token, apiBase: cfg.apiBase, timeoutMs: 60000 });
  api.token = t.token;

  // 目标清单：repo=owner/name | name=包名/插件名 | all=true（登记表全量）
  const targets = [];
  if (args.repo) {
    const m = /^([^/\s]+)\/([^/\s]+)$/u.exec(String(args.repo).trim());
    if (m === null) return { ok: false, summary: `repo 要是 owner/name 形式：${args.repo}`, checks: [] };
    targets.push({ owner: m[1], repo: m[2], folder: m[2], title: "", plugin: "" });
  } else if (args.name) {
    const needle = String(args.name).trim().toLowerCase();
    const hit = Object.entries(reg.repos).find(([repo, rec]) =>
      repo.toLowerCase() === needle || String(rec?.plugin ?? "").toLowerCase() === needle || String(rec?.folder ?? "").toLowerCase() === needle);
    if (hit === undefined) return { ok: false, summary: `登记表里没有 ${args.name}：先 action=list 看有哪些`, checks: [] };
    const [repo, rec] = hit;
    targets.push({ owner: rec.owner, repo, folder: rec.folder || repo, title: rec.title || "", plugin: rec.plugin || "" });
  } else if (args.all) {
    for (const [repo, rec] of Object.entries(reg.repos)) {
      targets.push({ owner: rec.owner, repo, folder: rec.folder || repo, title: rec.title || "", plugin: rec.plugin || "" });
    }
  } else {
    return { ok: false, summary: "download 需要 repo=owner/name、name=<包名> 或 all=true", checks: [] };
  }
  if (targets.length === 0) return { ok: false, summary: "目标为空：登记表是空的，先 action=scan 再 action=push", checks: [] };

  const roots = await effectiveRoots(cfg);
  const installRoot = args.into ? resolve(String(args.into)) : (cfg.installRoot || roots.roots[0] || configDirOf(cfgDir));
  const rows = [];
  for (const target of targets) {
    if (args.dryRun === true) {
      rows.push({ name: target.plugin || target.repo, title: target.title || target.repo, version: "", repo: `${target.owner}/${target.repo}`, repoUrl: `https://github.com/${target.owner}/${target.repo}`, dir: join(installRoot, target.folder), status: "new", changed: false, error: "" });
      continue;
    }
    const dir = join(installRoot, target.folder);
    const result = await downloadOne({ api, owner: target.owner, repo: target.repo, dir, link: args.link, profileDir: args.profileDir ? resolve(String(args.profileDir)) : "", cfg });
    rows.push({
      name: target.plugin || target.repo, title: target.title || target.repo, version: "", repo: `${target.owner}/${target.repo}`,
      repoUrl: `https://github.com/${target.owner}/${target.repo}`, dir: result.dir,
      status: result.ok ? (result.linked ? "installed" : "uploaded") : "failed",
      files: 0, bytes: result.bytes || 0, changed: true, error: result.error || result.linkError || "",
    });
  }
  const failed = rows.filter((row) => row.status === "failed");
  return {
    ok: failed.length === 0,
    plugins: rows,
    checks: [
      { name: "安装目录", ok: true, detail: installRoot },
      { name: "下载方式", ok: true, detail: "GitHub tarball（不需要 git）" + (args.link ? " · 已 link 进 profile" : "") },
    ],
    issues: failed.length === 0 ? [{ level: "info", msg: "重启 DSH 后新插件生效" }] : failed.map((row) => ({ level: "error", msg: `${row.name}：${row.error}` })),
    summary: args.dryRun === true
      ? `演练：将下载 ${rows.length} 个仓库到 ${installRoot}`
      : `${rows.length - failed.length}/${rows.length} 个仓库已下载${args.link ? " 并 link" : ""}${failed.length ? `，失败 ${failed.length}` : ""}`,
  };
}

/* ───────────────── 工具定义 ───────────────── */

const parameters = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["status", "init", "login", "login-status", "login-cancel", "logout", "auth", "scan", "push", "download", "install", "link", "list"],
      description: "status=自检；init=写配置（含 clientId）；login=设备码登录 GitHub；login-status=登录进度；login-cancel=取消登录；logout=退出并删本地令牌；auth=校验并保存 PAT；scan=扫描插件；push=上传到私有库；download=用 tarball 拉取（不需要 git，可 link）；install=用 git clone 装回；link=挂进 DSH profile；list=已上传清单",
    },
    clientId: { type: "string", description: "login：OAuth App 的 Client ID（device flow 用；也可在 init 时写进配置）" },
    scope: { type: "string", description: "login：申请的权限范围，默认 repo" },
    openBrowser: { type: "boolean", description: "login：是否自动打开授权页，默认 true" },
    dir: { type: "string", description: "插件目录（push/scan/link 用）；默认当前目录" },
    dirs: { type: "array", items: { type: "string" }, description: "push/scan 多个插件目录" },
    all: { type: "boolean", description: "push=同步全部插件；install=把登记表里本地还没有的都装上" },
    force: { type: "boolean", description: "push=忽略「无改动」也提交；install=覆盖已存在目录（先备份）" },
    dryRun: { type: "boolean", description: "push 演练：只算差异，不建库不提交" },
    token: { type: "string", description: "GitHub PAT（classic 勾 repo）。auth 时保存到 token.txt；其它动作只本次生效" },
    saveToken: { type: "boolean", description: "auth 是否把令牌写进 token.txt（默认写）" },
    owner: { type: "string", description: "仓库归属账号/组织；默认用令牌对应的账号" },
    repoPrefix: { type: "string", description: "仓库名前缀，如 dsh-plugin-（默认不加，直接用 package.json 的 name）" },
    message: { type: "string", description: "push 的提交信息（默认「chore(dsh): 同步 xxx v1.0.0」）" },
    maxFileMB: { type: "number", description: "单文件大小上限（MB），超过就跳过并在结果里列出" },
    allowPublic: { type: "boolean", description: "允许推到已存在的公开仓库（默认拒绝，要求私有）" },
    repo: { type: "string", description: "install：owner/name" },
    name: { type: "string", description: "install：按登记表里的包名/插件名安装" },
    into: { type: "string", description: "install：装到哪个目录（默认插件根目录）" },
    link: { type: "boolean", description: "install 后顺手 link 进 DSH profile" },
    profileDir: { type: "string", description: "DSH profile 目录（默认自动探测 ~/.dsh/profiles/desktop）" },
    noInstall: { type: "boolean", description: "link 时只改 profile/package.json，不跑 pnpm install" },
    refresh: { type: "boolean", description: "list 时联网核对仓库是否还在" },
    roots: { type: "array", items: { type: "string" }, description: "scan/init 的插件根目录" },
    configDir: { type: "string", description: "配置/登记表目录（默认 ~/.dsh/github-plugin-upload）" },
  },
};

const tool = {
  name: "github_upload",
  description:
    "「GitHub 门房 / 插件自动上传」：新机器上先用设备码登录 GitHub（或粘 PAT），再把这个插件库当通道，把 DSH 插件同步到 GitHub 私有库、或从私有库装回来。"
    + "login=设备码登录（OAuth App device flow，自动开浏览器，后台轮询）；login-status=看登录进度；login-cancel=取消；logout=退出登录；"
    + "status=自检（令牌/账号/插件目录/待同步）；init=初始化配置（可顺便写 clientId）；auth=校验并保存 PAT（不想建 OAuth App 时用它）；"
    + "scan=扫描插件并算建议仓库名与文件清单（只读不联网）；"
    + "push=上传（dir 单个 / dirs 多个 / all=true 全量增量，未改动自动跳过，首次自动建私有库，删除的文件自动从远端移除）；"
    + "download=用 GitHub tarball 把仓库拉成本地目录（不需要 git，可 link=true 直接挂进 profile，新机器第一次恢复就用它）；"
    + "install=从私有库 git clone 装回（机器上得有 git）；link=把已有目录挂进 profile；list=查看已上传清单。"
    + "走 GitHub REST Git Data API，不写 .git、不动工作区、只传变动的 blob。换机器恢复插件、备份插件、给插件建分发通道时用。",
  parameters,
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "action", "summary"],
      properties: {
        ok: { type: "boolean" },
        action: { type: "string" },
        summary: { type: "string" },
        detail: { type: "string" },
        userCode: { type: "string" },
        verificationUri: { type: "string" },
        expiresAt: { type: "integer" },
        opened: { type: "boolean" },
        login: { type: "string" },
        flow: { type: "object", additionalProperties: true },
        token: { type: "object", additionalProperties: true },
        cfgDir: { type: "string" },
        steps: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["name", "ok", "ms", "tail"],
            properties: { name: { type: "string" }, ok: { type: "boolean" }, ms: { type: "integer" }, tail: { type: "string" } },
          },
        },
        checks: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["name", "ok", "detail"],
            properties: { name: { type: "string" }, ok: { type: "boolean" }, detail: { type: "string" } },
          },
        },
        plugins: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["name", "title", "repo", "status"],
            properties: {
              name: { type: "string" }, title: { type: "string" }, version: { type: "string" },
              repo: { type: "string" }, repoUrl: { type: "string" }, status: { type: "string" },
              files: { type: "integer" }, bytes: { type: "integer" }, changed: { type: "boolean" },
              uploaded: { type: "integer" }, deleted: { type: "integer" },
              sha: { type: "string" }, dir: { type: "string" }, error: { type: "string" },
            },
          },
        },
        issues: {
          type: "array",
          items: {
            type: "object", additionalProperties: false, required: ["level", "msg"],
            properties: { level: { type: "string" }, msg: { type: "string" } },
          },
        },
        stats: {
          type: "object", additionalProperties: false, required: ["total", "changed", "unchanged", "failed"],
          properties: {
            total: { type: "integer" }, changed: { type: "integer" }, unchanged: { type: "integer" }, failed: { type: "integer" },
          },
        },
      },
    },
    render(_args, value) {
      const lines = [`${value.ok ? "✅" : "❌"} github_upload · ${value.action} · ${value.summary}`];
      for (const s of value.steps || []) {
        lines.push(`  ${s.ok ? "✓" : "✗"} ${s.name} (${(s.ms / 1000).toFixed(1)}s)`);
        if (s.tail) lines.push(...s.tail.split("\n").slice(0, 10).map((l) => "    " + l));
      }
      for (const c of value.checks || []) lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name}：${c.detail}`);
      if (value.plugins && value.plugins.length) {
        lines.push("插件：");
        const mark = { synced: "✓", uploaded: "✓", unchanged: "·", new: "＋", dirty: "↻", pushed: "↑", created: "＋", installed: "↓", failed: "✗", error: "✗", missing: "？", unknown: "？" };
        for (const p of value.plugins) {
          const m = mark[p.status] || "·";
          const extra = [
            p.version ? "v" + p.version : "",
            p.files ? `${p.files} 文件` : "",
            p.bytes ? kb(p.bytes) : "",
            p.uploaded ? `↑${p.uploaded}` : "",
            p.deleted ? `-${p.deleted}` : "",
            p.repoUrl || "",
            p.error ? "❌ " + p.error : "",
          ].filter(Boolean).join(" · ");
          lines.push(`  ${m} ${p.title || p.name}${extra ? "  " + extra : ""}`);
          if (p.dir) lines.push(`     ${p.dir}`);
        }
      }
      for (const i of value.issues || []) {
        if (i.level === "info") continue;
        lines.push(`  ${i.level === "error" ? "❌" : "⚠️"} ${i.msg}`);
      }
      return [{ type: "text", text: lines.join("\n") }];
    },
    presentationMeta(_args, value) {
      return { action: value.action, ok: value.ok };
    },
  },
  async execute(args) {
    const cfgDir = args.configDir ? resolve(String(args.configDir)) : "";
    const action = String(args.action);
    let res;
    if (action === "init") res = await doInit(cfgDir, args);
    else if (action === "login") res = await startLogin({ cfgDir: cfgDir || undefined, clientId: args.clientId, scope: args.scope, openBrowser: args.openBrowser !== false });
    else if (action === "login-status") res = await loginStatus({ cfgDir: cfgDir || undefined });
    else if (action === "login-cancel") res = cancelLogin({ cfgDir: cfgDir || undefined });
    else if (action === "logout") res = await logout({ cfgDir: cfgDir || undefined });
    else if (action === "auth") res = await doAuth(cfgDir, args);
    else if (action === "scan") res = await doScan(cfgDir, args);
    else if (action === "push") res = await doPush(cfgDir, args);
    else if (action === "download") res = await doDownload(cfgDir, args);
    else if (action === "install") res = await doInstall(cfgDir, args);
    else if (action === "link") res = await doLink(cfgDir, args);
    else if (action === "list") res = await doList(cfgDir, args);
    else res = await doStatus(cfgDir, args.refresh !== false);

    return {
      ok: !!res.ok,
      action,
      summary: res.summary || "",
      cfgDir: res.cfgDir || configDirOf(cfgDir),
      ...(res.detail ? { detail: res.detail } : {}),
      ...(res.userCode ? { userCode: res.userCode } : {}),
      ...(res.verificationUri ? { verificationUri: res.verificationUri } : {}),
      ...(typeof res.expiresAt === "number" ? { expiresAt: res.expiresAt } : {}),
      ...(typeof res.opened === "boolean" ? { opened: res.opened } : {}),
      ...(typeof res.login === "string" && res.login !== "" ? { login: res.login } : {}),
      ...(res.flow ? { flow: res.flow } : {}),
      ...(res.token ? { token: res.token } : {}),
      ...(res.steps ? { steps: res.steps } : {}),
      ...(res.checks ? { checks: res.checks } : {}),
      ...(res.plugins ? { plugins: res.plugins } : {}),
      ...(res.issues ? { issues: res.issues } : {}),
      ...(res.stats ? { stats: res.stats } : {}),
    };
  },
  presentCall(args) {
    return { card: "generic", title: `github_upload · ${args.action}`, kind: "execute", rawInput: args };
  },
};

/* ───────────────── 设置页的宿主半边（登录卡） ───────────────── */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function sendJson(response, status, payload) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload ?? {}));
}

async function readJsonBody(request, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "请求体过大");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function refuseUnadmitted(ctx, request, response) {
  const connection = ctx.get("connection");
  const gate = connection?.requestRejection;
  if (typeof gate !== "function") {
    const raw = request.headers.host;
    if (raw === undefined) return false;
    const host = raw.toLowerCase();
    if (/^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]|::1)(:\d+)?$/u.test(host)) return false;
    sendJson(response, 403, { error: "宿主没有 connection 服务，只允许本机访问" });
    return true;
  }
  let status;
  try {
    status = gate.call(connection, request);
  } catch {
    status = 403;
  }
  if (status === undefined) return false;
  sendJson(response, status, { error: status === 401 ? "需要先在 DSH 里登录" : "来源地址不受信任，已拒绝" });
  return true;
}

function sameOrigin(request) {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (origin === undefined || host === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function guarded(ctx, handler, options = {}) {
  return async (request, response) => {
    if (refuseUnadmitted(ctx, request, response)) return;
    if (options.mutating === true && !sameOrigin(request)) {
      sendJson(response, 403, { error: "跨站请求已拒绝" });
      return;
    }
    try {
      await handler(request, response);
    } catch (error) {
      sendJson(response, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(tool));
  // 插件卸载 / 重载时，别把后台轮询留在进程里
  ctx.effect(() => () => disposeLogin());

  ctx.effect(() => {
    const webServer = ctx.get("webServer");
    if (webServer === undefined || typeof webServer.register !== "function") {
      ctx.logger?.warn?.("github-plugin-upload: webServer 不可用，设置页登录卡不会出现（工具侧 action=login 仍然可用）");
      return () => {};
    }
    const disposers = [];
    const add = (path, handler) => disposers.push(webServer.register({ kind: "exact", path, handler }));

    add(`${ROUTE}/status`, guarded(ctx, async (_request, response) => {
      sendJson(response, 200, await loginStatus({ cfgDir: undefined }));
    }));

    add(`${ROUTE}/login`, guarded(ctx, async (request, response) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, await startLogin({
        cfgDir: undefined,
        clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        scope: typeof body.scope === "string" ? body.scope : undefined,
        openBrowser: body.openBrowser !== false,
      }));
    }, { mutating: true }));

    add(`${ROUTE}/login-cancel`, guarded(ctx, async (_request, response) => {
      sendJson(response, 200, cancelLogin({}));
    }, { mutating: true }));

    add(`${ROUTE}/token`, guarded(ctx, async (request, response) => {
      const body = await readJsonBody(request);
      const result = await doAuth("", { token: typeof body.token === "string" ? body.token : "", saveToken: body.saveToken !== false });
      if (!result.ok) throw new HttpError(400, result.summary || "令牌不可用");
      sendJson(response, 200, { ...result, ...(await loginStatus({ cfgDir: undefined })) });
    }, { mutating: true }));

    add(`${ROUTE}/logout`, guarded(ctx, async (_request, response) => {
      sendJson(response, 200, await logout({ cfgDir: undefined }));
    }, { mutating: true }));

    ctx.logger?.info?.(`github-plugin-upload: 登录卡路由已挂载 ${ROUTE}/*`);
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 已卸载 */
        }
      }
    };
  });
}
