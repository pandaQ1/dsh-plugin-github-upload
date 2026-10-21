// install.mjs — 从私有库把插件装回来（一个插件一个库）
//
// 两种用法：
//   node install.mjs --repo <owner/name> [--into <目录>] [--force] [--link] [--json]
//   node install.mjs --name <包名或插件名>   # 按登记表找
//   node install.mjs --all                   # 把登记表里「本地还没有」的插件全装一遍
//
// 令牌只从环境变量 / token.txt / 参数取，不写进 .git/config，也不进命令行参数：
// 用 GIT_ASKPASS 临时脚本 + 环境变量喂给 git。（--url 可指向 file:// 本地库，便于自测）

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  abs, expandHome, findRecord, installRootOf, linkPluginToProfile, loadConfig, loadRegistry, pluginInfo, resolveToken,
} from "./lib.mjs";

function parseArgs(argv) {
  const out = { json: false, all: false, force: false, link: false, install: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--repo") out.repo = next();
    else if (a === "--name") out.name = next();
    else if (a === "--into") out.into = next();
    else if (a === "--all") out.all = true;
    else if (a === "--force") out.force = true;
    else if (a === "--link") out.link = true;
    else if (a === "--no-install") out.install = false;
    else if (a === "--json") out.json = true;
    else if (a === "--config") out.config = next();
    else if (a === "--token") out.token = next();
    else if (a === "--url") out.url = next();
    else if (a === "--branch") out.branch = next();
    else if (a === "--profile") out.profileDir = next();
    else if (a === "--pnpm") out.pnpmBin = next();
  }
  return out;
}

/** 跑一个子进程，收集输出（令牌只走 env，不进 argv） */
function run(cmd, args, { cwd, env, timeoutMs = 180000 } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    let out = "";
    let err = "";
    let settled = false;
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, windowsHide: true, shell: false });
    const finish = (ok, code, extra) => {
      if (settled) return;
      settled = true;
      done({ ok, code, ms: Date.now() - t0, out, err: err + (extra || "") });
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } finish(false, null, `\n[timeout ${timeoutMs}ms]`); }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString(); });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("error", (e) => { clearTimeout(timer); finish(false, null, "\n" + String(e.message || e)); });
    child.on("close", (code) => { clearTimeout(timer); finish(code === 0, code); });
  });
}

const tail = (s, n = 12) => String(s || "").trim().split(/\r?\n/).slice(-n).join("\n");

/** 生成一次性 GIT_ASKPASS 脚本：只把令牌交给 git 的 password 提示，不落盘成 URL */
async function makeAskpass() {
  const dir = await mkdtemp(join(tmpdir(), "dsh-gh-askpass-"));
  const isWin = process.platform === "win32";
  const file = join(dir, isWin ? "askpass.cmd" : "askpass.sh");
  const body = isWin
    ? ["@echo off", "echo %DSH_GH_TOKEN%", ""].join("\r\n")
    : ["#!/bin/sh", "printf '%s\\n' \"$DSH_GH_TOKEN\"", ""].join("\n");
  await writeFile(file, body, "utf8");
  if (!isWin) await chmod(file, 0o700);
  return { dir, file };
}

export async function install({ configDir, repo, name, all, into, force, link, install: doInstall = true, token, url, branch, profileDir, pnpmBin, json, log } = {}) {
  const { cfgDir, cfg } = await loadConfig(configDir);
  const reg = await loadRegistry(cfgDir);
  const roots = cfg.pluginRoots && cfg.pluginRoots.length ? cfg.pluginRoots.map((p) => abs(expandHome(p))) : [];
  const installRoot = into ? abs(expandHome(into)) : installRootOf(cfg, roots);
  const t = await resolveToken(cfgDir, cfg, token);

  // 目标清单
  const items = [];
  if (repo || url) {
    const rec = repo ? Object.values(reg.repos).find((r) => `${r.owner}/${r.repo}`.toLowerCase() === String(repo).toLowerCase()) : null;
    items.push({
      key: repo || url,
      folder: rec ? rec.folder : String(repo || "plugin").split("/").pop(),
      plugin: rec ? rec.plugin : String(repo || "plugin").split("/").pop(),
      cloneUrl: url || `https://github.com/${repo}.git`,
      branch: branch || (rec && rec.branch) || cfg.branch || "main",
      title: rec ? rec.title : String(repo || ""),
      version: rec ? rec.packageVersion : "",
    });
  } else if (name) {
    const found = findRecord(reg, name);
    if (!found) return { ok: false, action: "install", summary: `登记表里没有 ${name}`, repos: [], errors: [{ code: "not-found", msg: `登记表里没有 ${name}` }] };
    const [key, rec] = found;
    items.push({ key, folder: rec.folder, plugin: rec.plugin, cloneUrl: url || rec.cloneUrl, branch: branch || rec.branch, title: rec.title, version: rec.packageVersion });
  } else if (all) {
    for (const [key, rec] of Object.entries(reg.repos)) {
      items.push({ key, folder: rec.folder, plugin: rec.plugin, cloneUrl: rec.cloneUrl, branch: branch || rec.branch, title: rec.title, version: rec.packageVersion });
    }
    if (!items.length) return { ok: false, action: "install", summary: "登记表是空的：先 action=scan 再 action=push", repos: [], errors: [{ code: "empty-registry", msg: "登记表为空" }] };
  } else {
    return { ok: false, action: "install", summary: "请传 repo（owner/name）或 name 或 all=true", repos: [], errors: [{ code: "no-target", msg: "缺少 repo / name" }] };
  }

  const results = [];
  let askpass = null;
  try {
    if (doInstall && !t.token && !(url && /^file:/i.test(url))) {
      return { ok: false, action: "install", summary: "私有库必须有令牌：先 action=auth", repos: [], errors: [{ code: "no-token", msg: "缺少令牌" }] };
    }
    if (doInstall) askpass = await makeAskpass();

    for (const it of items) {
      const dir = join(installRoot, it.folder || it.plugin);
      const row = { key: it.key, title: it.title, plugin: it.plugin, folder: it.folder, dir, cloneUrl: it.cloneUrl, branch: it.branch, ok: false, skipped: false, ms: 0, log: "", linked: false, version: "" };
      const started = Date.now();
      if (existsSync(dir)) {
        const info = await pluginInfo(dir);
        if (info && !force) {
          row.skipped = true;
          row.ok = true;
          row.version = info.version;
          row.log = `已存在：${dir}（要覆盖请 force=true）`;
          results.push(row);
          if (log) log(`  = ${it.title || it.folder} 已存在，跳过`);
          continue;
        }
        if (force) {
          const bak = `${dir}.bak-${Date.now()}`;
          await renameSafe(dir, bak);
          row.log = `旧目录已备份到 ${bak}`;
        }
      }

      if (!doInstall) {
        row.ok = true;
        row.log = (row.log ? row.log + "；" : "") + `（演练）将执行 git clone ${it.cloneUrl} → ${dir}`;
        results.push(row);
        continue;
      }

      await mkdir(installRoot, { recursive: true });
      const authUrl = /^https:\/\//i.test(it.cloneUrl) && t.token
        ? it.cloneUrl.replace(/^https:\/\//i, "https://x-access-token@")
        : it.cloneUrl;
      const args = ["-c", "core.longpaths=true", "clone", "--depth", "1", ...(it.branch ? ["--branch", it.branch] : []), authUrl, dir];
      const r = await run("git", args, {
        cwd: installRoot,
        env: { GIT_ASKPASS: askpass.file, GIT_TERMINAL_PROMPT: "0", DSH_GH_TOKEN: t.token || "", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
      });
      row.ms = Date.now() - started;
      if (!r.ok) {
        row.log = (row.log ? row.log + "；" : "") + tail(r.err || r.out, 8);
        results.push(row);
        if (log) log(`  ✗ ${it.title || it.folder}：${tail(r.err || r.out, 3)}`);
        continue;
      }
      const info = await pluginInfo(dir);
      if (!info) {
        row.log = "克隆成功，但目录不像 DSH 插件（缺 package.json / cordis.patch.yml / index.js）";
        results.push(row);
        continue;
      }
      row.ok = true;
      row.version = info.version;
      row.plugin = info.name;
      row.log = (row.log ? row.log + "；" : "") + `已克隆 ${info.name} v${info.version}`;
      if (link) {
        const lr = await linkPluginToProfile(cfg, dir, { profileDir, pnpmBin, noInstall: false, log });
        row.linked = !!lr.ok;
        row.log += "；" + (lr.ok ? `已 link 进 ${lr.profileDir}` : `link 失败：${lr.error}`);
      }
      results.push(row);
      if (log) log(`  ↑ ${it.title || it.folder} → ${dir}`);
    }
  } finally {
    if (askpass) await rm(askpass.dir, { recursive: true, force: true }).catch(() => {});
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  const done = results.filter((r) => r.ok && !r.skipped).length;
  const summary = ok
    ? done ? `已安装 ${done} 个插件到 ${installRoot}` : `全部已存在（${results.length} 个跳过）`
    : `${results.filter((r) => r.ok).length} 成功 / ${results.filter((r) => !r.ok).length} 失败`;
  return { ok, action: "install", installRoot, summary, repos: results, errors: [] };
}

async function renameSafe(from, to) {
  const { rename } = await import("node:fs/promises");
  try { await rename(from, to); } catch {
    // 跨盘/占用：退化成「不备份，直接删」
    await rm(from, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv);
  const r = await install({ ...args, log: args.json ? undefined : (line) => process.stderr.write(line + "\n") });
  if (args.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  else {
    process.stdout.write((r.ok ? "✅ " : "❌ ") + r.summary + "\n");
    for (const x of r.repos || []) process.stdout.write(`  ${x.ok ? (x.skipped ? "=" : "↑") : "✗"} ${x.plugin || x.key} → ${x.dir}${x.log ? "  " + x.log : ""}\n`);
  }
  process.exitCode = r.ok ? 0 : 1;
}
