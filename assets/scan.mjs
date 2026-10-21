// scan.mjs — 扫描现有 DSH 插件，给出「建议仓库名 / 文件清单 / 是否已上传 / 是否有改动」
//
// 用法：
//   node scan.mjs [--config <dir>] [--roots a;b] [--dir <插件目录>] [--json]
//
// 只读：不碰网络，不写任何文件。

import { pathToFileURL } from "node:url";
import {
  abs, effectiveRoots, expandHome, kb, loadConfig, loadRegistry, pluginInfo, repoNameFor, scanRoots, treeIdOf, walkFiles,
} from "./lib.mjs";

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--config") out.config = next();
    else if (a === "--roots") out.roots = String(next()).split(";").map((s) => s.trim()).filter(Boolean);
    else if (a === "--dir") out.dir = next();
    else if (a === "--json") out.json = true;
    else if (a === "--max-file-mb") out.maxFileMB = Number(next());
  }
  return out;
}

export async function scan({ configDir, roots, dir, maxFileMB } = {}) {
  const { cfgDir, cfg } = await loadConfig(configDir);
  const reg = await loadRegistry(cfgDir);
  let rootList;
  let auto = false;
  if (dir) {
    rootList = [abs(expandHome(dir))];
  } else if (roots && roots.length) {
    rootList = roots.map((r) => abs(expandHome(r)));
  } else {
    const eff = await effectiveRoots(cfg);
    rootList = eff.roots;
    auto = eff.auto;
  }
  const scanned = dir ? { plugins: [], errors: [] } : await scanRoots(rootList);
  if (dir) {
    const info = await pluginInfo(dir);
    if (info) scanned.plugins.push(info);
    else scanned.errors.push({ dir: abs(expandHome(dir)), error: "不是 DSH 插件（需要 package.json + cordis.patch.yml + index.js）" });
  }

  const extraExcludes = cfg.exclude || [];
  const plugins = [];
  for (const p of scanned.plugins) {
    const repo = repoNameFor(p, cfg);
    const rec = reg.repos[repo];
    const row = {
      name: p.name,
      title: p.title,
      version: p.version,
      folder: p.folder,
      dir: p.dir,
      repo,
      repoUrl: rec ? rec.repoUrl || "" : "",
      uploaded: !!rec,
      changed: true,
      files: 0,
      bytes: 0,
      treeId: "",
      skipped: [],
      skippedCount: 0,
      error: "",
    };
    try {
      const w = await walkFiles(p.dir, { extraExcludes, maxFileMB: maxFileMB || cfg.maxFileMB });
      row.files = w.files.length;
      row.bytes = w.bytes;
      row.treeId = treeIdOf(w.files);
      row.skippedCount = w.skipped.length;
      row.skipped = w.skipped.slice(0, 8).map((s) => `${s.rel}（${s.reason}）`);
      row.changed = !rec || rec.treeId !== row.treeId;
      row.lastPushedAt = rec?.pushedAt || "";
      row.lastSha = rec?.sha || "";
      row.branch = rec?.branch || cfg.branch || "main";
    } catch (e) {
      row.error = String(e.message || e);
    }
    plugins.push(row);
  }

  return {
    ok: scanned.errors.length === 0,
    cfgDir,
    roots: rootList,
    autoRoots: auto,
    owner: cfg.owner === "auto" ? "" : cfg.owner,
    visibility: cfg.visibility || "private",
    installRoot: cfg.installRoot || "",
    plugins,
    errors: scanned.errors,
    uploadedCount: plugins.filter((p) => p.uploaded).length,
    changedCount: plugins.filter((p) => p.changed).length,
    registryCount: Object.keys(reg.repos).length,
  };
}

function render(r) {
  const lines = [];
  lines.push(`扫描根：${r.roots.join(" · ")}${r.autoRoots ? "（自动探测）" : ""}`);
  lines.push(`插件 ${r.plugins.length} 个 · 已上传 ${r.uploadedCount} · 有改动 ${r.changedCount}`);
  for (const p of r.plugins) {
    const mark = p.error ? "❌" : !p.uploaded ? "＋" : p.changed ? "↻" : "✓";
    lines.push(`  ${mark} ${p.title}  ${p.version}  ${p.files} 文件 / ${kb(p.bytes)}`);
    lines.push(`     ${p.name} → ${p.repo}${p.uploaded ? (p.changed ? "（有改动待上传）" : "（已同步）") : "（尚未建库）"}`);
    if (p.error) lines.push(`     ❌ ${p.error}`);
    const skipped = p.skippedCount ? `跳过 ${p.skippedCount} 项：${p.skipped.join("、")}` : "";
    if (skipped) lines.push(`     ${skipped}`);
  }
  for (const e of r.errors) lines.push(`  ⚠️ ${e.root || e.dir}：${e.error}`);
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv);
  const r = await scan({ configDir: args.config, roots: args.roots, dir: args.dir, maxFileMB: args.maxFileMB });
  if (args.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  else process.stdout.write(render(r) + "\n");
  process.exitCode = r.ok ? 0 : 1;
}
