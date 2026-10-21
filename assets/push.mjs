// push.mjs — 把 DSH 插件上传到 GitHub 私有库（一个插件一个库）
//
// 用 GitHub REST 的 Git Data API 一次性提交整棵树：
//   blobs → tree → commit → 更新 ref
// 好处：不写 .git、不改工作区、增量只传变了的 blob、删掉的文件会自动从树里移除。
//
// 用法：
//   node push.mjs --dir <插件目录> [--json] [--dry-run]
//   node push.mjs --dirs "a;b" [--json]
//   node push.mjs --all [--force] [--json] [--config <dir>]
//   node push.mjs --token <t> --api-base <url>    # 测试用；正常从环境变量 / token.txt 取
//
// 退出码：0 全部成功；1 有失败

import { pathToFileURL } from "node:url";
import {
  abs, createPrivateRepo, effectiveRoots, expandHome, getHead, getRepo, gitBlobSha, initEmptyRepo, kb, loadConfig,
  loadRegistry, makeApi, pluginInfo, readmeFor, repoNameFor, resolveToken, saveRegistry, scanRoots, treeIdOf,
  walkFiles, whoAmI,
} from "./lib.mjs";

function parseArgs(argv) {
  const out = { json: false, all: false, force: false, dryRun: false, dirs: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--dir") out.dirs.push(next());
    else if (a === "--dirs") out.dirs.push(...String(next()).split(";").map((s) => s.trim()).filter(Boolean));
    else if (a === "--all") out.all = true;
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else if (a === "--config") out.config = next();
    else if (a === "--token") out.token = next();
    else if (a === "--api-base") out.apiBase = next();
    else if (a === "--owner") out.owner = next();
    else if (a === "--repo-prefix") out.repoPrefix = next();
    else if (a === "--message") out.message = next();
    else if (a === "--max-file-mb") out.maxFileMB = Number(next());
    else if (a === "--allow-public") out.allowPublic = true;
  }
  return out;
}

const HINTS = {
  401: "令牌无效或已过期：重新生成 PAT，然后 action=auth 保存",
  403: "权限不足：classic PAT 需要勾选 repo；fine-grained 需要 Administration + Contents 的读写权限",
  404: "仓库/账号不存在，或令牌看不到它（私有库必须有 repo / Contents 权限）",
  422: "参数被拒（常见：同名仓库已存在、仓库名不合法）",
  409: "仓库为空或 ref 冲突：再跑一次通常即可",
};

export function explain(err) {
  const status = err && err.status;
  const base = String((err && err.message) || err || "未知错误");
  return status && HINTS[status] ? `${base} → ${HINTS[status]}` : base;
}

function emptyRow(plugin, owner, cfg, extra = {}) {
  return {
    name: plugin.name, title: plugin.title, version: plugin.version, folder: plugin.folder, dir: plugin.dir,
    repo: `${owner}/${repoNameFor(plugin, cfg)}`, repoUrl: "", branch: cfg.branch || "main", sha: "",
    files: 0, bytes: 0, newRepo: false, uploaded: 0, reused: 0, deleted: 0, nochange: false,
    dryRun: false, addedReadme: false, initRepo: false, treeId: "", skipped: [], skippedCount: 0, error: "",
    ...extra,
  };
}

/** 单个插件：确保仓库存在 → 比对 → 上传变动的 blob → 建树 / 提交 / 更新 ref → 登记 */
async function pushOne(ctx, plugin, opts) {
  const { api, cfg, owner, reg, cfgDir, orgMode, me } = ctx;
  const repo = repoNameFor(plugin, cfg);
  const full = `${owner}/${repo}`;
  const row = emptyRow(plugin, owner, cfg, { dryRun: !!opts.dryRun });

  // 1) 本地清单（含 blob sha，可直接和远端比）
  const walk = opts.walk || await walkFiles(plugin.dir, { extraExcludes: cfg.exclude, maxFileMB: opts.maxFileMB || cfg.maxFileMB });
  if (!walk.files.length) throw new Error("插件目录里没有可上传的文件（检查 exclude 配置）");
  const pushSet = [...walk.files];
  row.files = walk.files.length;
  row.bytes = walk.bytes;
  row.treeId = treeIdOf(walk.files);
  row.skipped = walk.skipped.slice(0, 10).map((s) => `${s.rel}（${s.reason}）`);
  row.skippedCount = walk.skipped.length;

  // 2) 仓库（不存在就建私有库）
  let repoInfo = await getRepo(api, owner, repo);
  if (repoInfo && !repoInfo.private && !opts.allowPublic && (cfg.visibility || "private") === "private") {
    throw new Error(`目标库 ${full} 是公开库，已拒绝上传（确实要公开请传 allowPublic=true）`);
  }
  // 插件自己没有 README 时，补一份「怎么装回去」的说明（只进仓库，不落盘）
  if (!pushSet.some((f) => f.rel.toLowerCase() === "readme.md")) {
    const buf = Buffer.from(readmeFor(plugin, owner, repo), "utf8");
    pushSet.push({ rel: "README.md", abs: "(生成)", size: buf.length, sha: gitBlobSha(buf), buf, mode: "100644" });
    row.addedReadme = true;
  }
  if (!repoInfo) {
    row.newRepo = true;
    if (opts.dryRun) {
      row.uploaded = pushSet.length;
      row.sha = "(dry-run)";
      return row;
    }
    repoInfo = await createPrivateRepo(api, orgMode ? owner : "", repo, { description: `${plugin.title} · DSH 插件` });
  }
  const branch = (repoInfo && repoInfo.default_branch) || cfg.branch || "main";

  // 3) 远端现状
  let head = await getHead(api, owner, repo, branch);
  // 已存在的空库（没有任何提交）没法直接用 blobs/trees（GitHub 返回 409 Git Repository is empty）：
  // 先用 Contents API 写一个 README，把它变成「有提交的库」再继续。
  if (head.empty && !opts.dryRun) {
    const readmeFile = pushSet.find((f) => f.rel.toLowerCase() === "readme.md");
    await initEmptyRepo(
      api, owner, repo, branch,
      readmeFile ? readmeFile.rel : "README.md",
      readmeFile ? readmeFile.buf : Buffer.from("# init\n", "utf8"),
    );
    row.initRepo = true;
    head = await getHead(api, owner, repo, branch);
    if (head.empty) throw new Error("仓库是空的，初始化也没有生效：先在 GitHub 网页上建一个 README 再重试");
  }
  const remote = head.empty ? new Map() : head.entries;
  if (head.truncated) row.note = "远端树过大被截断，本次按全量比对";

  // 4) 差异：只传 sha 变了的；远端有、本地没有的 = 删除
  const toUpload = [];
  let reused = 0;
  for (const f of pushSet) {
    if (remote.get(f.rel) === f.sha) reused++;
    else toUpload.push(f);
  }
  const localPaths = new Set(pushSet.map((f) => f.rel));
  row.uploaded = toUpload.length;
  row.reused = reused;
  row.deleted = [...remote.keys()].filter((p) => !localPaths.has(p)).length;

  if (opts.dryRun) {
    row.sha = head.empty ? "(dry-run)" : head.sha;
    row.nochange = !head.empty && row.uploaded === 0 && row.deleted === 0;
    return row;
  }
  if (!head.empty && row.uploaded === 0 && row.deleted === 0) {
    row.nochange = true;
    row.sha = head.sha;
    const rec = reg.repos[repo];
    if (rec && rec.treeId !== row.treeId) {
      rec.treeId = row.treeId;
      rec.packageVersion = plugin.version;
      rec.dir = plugin.dir;
      await saveRegistry(cfgDir, reg);
    }
    return row;
  }

  // 5) 上传变化的 blob
  const entries = [];
  for (const f of pushSet) {
    let sha = remote.get(f.rel);
    if (!sha || sha !== f.sha) {
      const r = await api.post(`/repos/${full}/git/blobs`, { content: f.buf.toString("base64"), encoding: "base64" });
      sha = r.data && r.data.sha;
      if (!sha) throw new Error(`blob 上传没有返回 sha：${f.rel}`);
    }
    entries.push({ path: f.rel, mode: f.mode || "100644", type: "blob", sha });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));

  // 6) 建树
  const treeRes = await api.post(`/repos/${full}/git/trees`, { tree: entries });
  const treeSha = treeRes.data && treeRes.data.sha;
  if (!treeSha) throw new Error("建树失败：GitHub 没返回 tree sha");

  // 7) 提交
  const msg = opts.message || `chore(dsh): 同步 ${plugin.title} v${plugin.version}（${pushSet.length} 个文件）`;
  const commitRes = await api.post(`/repos/${full}/git/commits`, { message: msg, tree: treeSha, parents: head.empty ? [] : [head.sha] });
  const newSha = commitRes.data && commitRes.data.sha;
  if (!newSha) throw new Error("提交失败：GitHub 没返回 commit sha");

  // 8) 更新分支
  await api.patch(`/repos/${full}/git/refs/heads/${branch}`, { sha: newSha, force: false });

  row.sha = newSha;

  // 9) 登记
  reg.repos[repo] = {
    plugin: plugin.name, title: plugin.title, folder: plugin.folder, dir: plugin.dir,
    owner, repo, repoUrl: `https://github.com/${full}`, cloneUrl: `https://github.com/${full}.git`,
    private: true, branch, sha: newSha, treeSha, treeId: row.treeId,
    packageVersion: plugin.version, files: pushSet.length, bytes: row.bytes,
    pushedAt: new Date().toISOString(),
  };
  await saveRegistry(cfgDir, reg);

  // 10) 顺手同步仓库描述（失败不影响结果）
  try {
    if (!repoInfo || repoInfo.description !== `${plugin.title} · DSH 插件`) {
      await api.patch(`/repos/${full}`, { description: `${plugin.title} · DSH 插件`, private: true });
    }
  } catch { /* 忽略 */ }

  return row;
}

export async function push({ configDir, dirs, all, force, dryRun, token, apiBase, owner, repoPrefix, message, maxFileMB, allowPublic, log } = {}) {
  const { cfgDir, cfg } = await loadConfig(configDir);
  if (apiBase) cfg.apiBase = apiBase;
  if (repoPrefix !== undefined) cfg.repoPrefix = repoPrefix;

  const t = await resolveToken(cfgDir, cfg, token);
  if (!t.token) {
    return {
      ok: false, action: "push", cfgDir,
      summary: "还没有 GitHub 令牌：先 action=auth 存一个带 repo 权限的 PAT",
      plugins: [], errors: [{ code: "no-token", msg: "缺少令牌", hint: "设置环境变量 GITHUB_TOKEN，或 action=auth token=ghp_xxx" }],
      stats: { total: 0, changed: 0, unchanged: 0, failed: 0 },
    };
  }

  const api = makeApi({ token: t.token, apiBase: cfg.apiBase, onLog: log });
  let me;
  try {
    me = await whoAmI(api);
  } catch (e) {
    return {
      ok: false, action: "push", cfgDir, plugins: [], stats: { total: 0, changed: 0, unchanged: 0, failed: 0 },
      summary: `令牌不可用：${explain(e)}`,
      errors: [{ code: "auth", msg: explain(e), hint: "换一个带 repo 权限的 PAT 后 action=auth 重新保存" }],
    };
  }
  const resolvedOwner = owner || (cfg.owner && cfg.owner !== "auto" ? cfg.owner : me.login);
  const reg = await loadRegistry(cfgDir);
  const ctx = { api, cfg, owner: resolvedOwner, reg, cfgDir, me, orgMode: resolvedOwner !== me.login };

  // 目标插件
  const targets = [];
  const errors = [];
  if (dirs && dirs.length) {
    for (const d of dirs) {
      const info = await pluginInfo(abs(expandHome(d)));
      if (!info) errors.push({ code: "not-plugin", msg: `${d} 不是 DSH 插件（需要 package.json + cordis.patch.yml + index.js）` });
      else targets.push(info);
    }
  } else if (all) {
    const eff = await effectiveRoots(cfg);
    const scanned = await scanRoots(eff.roots);
    for (const e of scanned.errors) errors.push({ code: "scan", msg: `${e.root || e.dir}：${e.error}` });
    targets.push(...scanned.plugins);
  } else {
    const info = await pluginInfo(process.cwd());
    if (info) targets.push(info);
    else errors.push({ code: "not-plugin", msg: "当前目录不是 DSH 插件，请传 dir 或 all=true" });
  }

  const rows = [];
  let unchanged = 0;
  for (const plugin of targets) {
    const repo = repoNameFor(plugin, cfg);
    const rec = reg.repos[repo];
    try {
      // 未改动且不强制：先算 treeId 便宜地跳过（省一次网络往返）
      const walk = await walkFiles(plugin.dir, { extraExcludes: cfg.exclude, maxFileMB: maxFileMB || cfg.maxFileMB });
      const treeId = treeIdOf(walk.files);
      if (!force && rec && rec.treeId === treeId) {
        unchanged++;
        rows.push(emptyRow(plugin, resolvedOwner, cfg, {
          repo: `${resolvedOwner}/${repo}`, repoUrl: rec.repoUrl || "", branch: rec.branch || cfg.branch,
          sha: rec.sha || "", files: walk.files.length, bytes: walk.bytes, treeId, nochange: true,
          dryRun: !!dryRun, reused: walk.files.length,
        }));
        if (log) log(`  = ${plugin.title} → ${repo} 无改动`);
        continue;
      }
      const row = await pushOne(ctx, plugin, { dryRun, message, maxFileMB, allowPublic, walk });
      rows.push(row);
      if (row.nochange) unchanged++;
      if (log) log(`  ${row.nochange ? "=" : dryRun ? "…" : "↑"} ${plugin.title} → ${row.repo} ${row.nochange ? "无改动" : `+${row.uploaded} ~${row.reused} -${row.deleted}`}`);
    } catch (e) {
      rows.push(emptyRow(plugin, resolvedOwner, cfg, {
        repo: `${resolvedOwner}/${repo}`, error: explain(e), dryRun: !!dryRun,
      }));
      if (log) log(`  ✗ ${plugin.title}：${explain(e)}`);
    }
  }

  const failed = rows.filter((r) => r.error);
  const changed = rows.filter((r) => !r.error && !r.nochange);
  const ok = failed.length === 0 && errors.length === 0;
  const summary = failed.length || errors.length
    ? `${rows.length - failed.length} 成功 / ${failed.length + errors.length} 失败`
    : changed.length
      ? `${dryRun ? "（演练）" : "已上传"} ${changed.length} 个插件 · ${changed.reduce((n, r) => n + r.uploaded, 0)} 个文件变动`
      : `全部已是最新（${rows.length} 个插件无改动）`;

  return {
    ok, action: "push", cfgDir, owner: resolvedOwner, login: me.login, tokenSource: t.source,
    summary, plugins: rows, errors,
    stats: { total: rows.length, changed: changed.length, unchanged, failed: failed.length },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv);
  const r = await push({ ...args, log: args.json ? undefined : (line) => process.stderr.write(line + "\n") });
  if (args.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  else {
    process.stdout.write((r.ok ? "✅ " : "❌ ") + r.summary + "\n");
    for (const p of r.plugins || []) {
      process.stdout.write(`  ${p.error ? "✗" : p.nochange ? "=" : "↑"} ${p.title} → ${p.repo} ${p.error ? p.error : p.nochange ? "" : `+${p.uploaded} ~${p.reused} -${p.deleted}`}\n`);
    }
    for (const e of r.errors || []) process.stdout.write(`  ⚠️ ${e.msg}\n`);
  }
  process.exitCode = r.ok ? 0 : 1;
}
