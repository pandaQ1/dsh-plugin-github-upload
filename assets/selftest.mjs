// selftest.mjs — 无外网自测：本地 mock 一个 GitHub REST 服务，把 push / install / link 全流程跑一遍
//
//   node selftest.mjs            # 全部自测
//   node selftest.mjs --keep     # 保留临时目录，便于排查
//
// 覆盖：
//   · 仓库名清洗（中文 → ASCII）、git blob sha、排除规则、treeId 稳定性
//   · 首次 push：建私有库 + 全量树 + 自动补 README
//   · 二次 push：无改动 → 不产生提交
//   · 改一个文件 → 只传 1 个 blob；删一个文件 → 远端树里消失
//   · 公开库加固：拒绝往公开库推
//   · dry-run：不建库、不提交
//   · install：从本地裸库克隆装回；已存在则跳过
//   · link：写 profile/package.json 的 link 依赖与 bundles（noInstall 模式）

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gitBlobSha, linkPluginToProfile, pluginInfo, repoNameFor, treeIdOf, walkFiles,
} from "./lib.mjs";
import { push } from "./push.mjs";
import { install } from "./install.mjs";

const KEEP = process.argv.includes("--keep");
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? " — " + extra : "")); console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

/* ───────── mock GitHub REST ───────── */

function makeMock({ token = "test-token" } = {}) {
  const blobs = new Map();   // sha → Buffer
  const trees = new Map();   // sha → entries[]
  const commits = new Map(); // sha → { tree, parents, message }
  const repos = new Map();   // "owner/name" → { private, default_branch, head }
  const stats = { blobPosts: 0, commitPosts: 0, repoCreates: 0, unauthorized: 0 };
  let seq = 0;

  // 建一次提交并把仓库头指过去（auto_init / contents / git-commits 共用）
  function putCommit(key, entries, message, parents) {
    const treeSha = sha1(JSON.stringify(entries.map((e) => [e.path, e.sha, e.mode, e.type])));
    trees.set(treeSha, entries);
    const commitSha = sha1("commit:" + (++seq) + ":" + treeSha + ":" + (parents || []).join(","));
    commits.set(commitSha, { tree: treeSha, parents: parents || [], message });
    const repo = repos.get(key) || { private: true, default_branch: "main", head: null, description: "" };
    repo.head = commitSha;
    repos.set(key, repo);
    stats.commitPosts++;
    return commitSha;
  }

  const json = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const notFound = (res) => json(res, 404, { message: "Not Found" });

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;
    const m = req.method;
    if (p === "/_stats") return json(res, 200, stats);
    if (p === "/_repos") return json(res, 200, Object.fromEntries(repos));
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) { stats.unauthorized++; return json(res, 401, { message: "Bad credentials" }); }
    const body = raw ? JSON.parse(raw) : {};

    // /repos/:o/:r/git/...
    let mm = p.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/(ref|refs|blobs|trees|commits)(?:\/(.+))?$/);
    if (mm) {
      const [, o, r, kind, rest] = mm;
      const key = `${o}/${r}`;
      if (kind === "blobs" && m === "POST") {
        const buf = Buffer.from(String(body.content || ""), body.encoding === "base64" ? "base64" : "utf8");
        const sha = gitBlobSha(buf);
        blobs.set(sha, buf);
        stats.blobPosts++;
        return json(res, 201, { sha });
      }
      if (kind === "trees" && m === "POST") {
        const entries = body.tree || [];
        const sha = sha1(JSON.stringify(entries.map((e) => [e.path, e.sha, e.mode, e.type])));
        trees.set(sha, entries);
        return json(res, 201, { sha, tree: entries });
      }
      if (kind === "trees" && m === "GET") return trees.has(rest) ? json(res, 200, { sha: rest, tree: trees.get(rest), truncated: false }) : notFound(res);
      if (kind === "commits" && m === "POST") {
        const sha = putCommit(key, trees.get(body.tree) || [], body.message, body.parents || []);
        return json(res, 201, { sha, tree: { sha: body.tree } });
      }
      if (kind === "commits" && m === "GET") {
        const c = commits.get(rest);
        return c ? json(res, 200, { sha: rest, tree: { sha: c.tree }, commit: { message: c.message } }) : notFound(res);
      }
      if (kind === "ref" && m === "GET") {
        const repo = repos.get(key);
        if (!repo || !repo.head) return notFound(res);
        return json(res, 200, { ref: "refs/heads/" + rest.replace(/^heads\//, ""), object: { sha: repo.head } });
      }
      if (kind === "refs" && m === "POST") {
        const repo = repos.get(key) || { private: true, default_branch: "main", head: null };
        repo.head = body.sha;
        repos.set(key, repo);
        return json(res, 201, { ref: body.ref, object: { sha: body.sha } });
      }
      if (kind === "refs" && m === "PATCH") {
        const repo = repos.get(key);
        if (!repo) return notFound(res);
        repo.head = body.sha;
        return json(res, 200, { object: { sha: body.sha } });
      }
      return notFound(res);
    }

    // PUT /repos/:o/:r/contents/:path —— 空库初始化兜底（GitHub 对空库的 blobs/trees 会 409）
    mm = p.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (mm && m === "PUT") {
      const [, o, r, relPath] = mm;
      const key = `${o}/${r}`;
      const repo = repos.get(key);
      if (!repo) return notFound(res);
      const buf = Buffer.from(String(body.content || ""), "base64");
      const blobSha = gitBlobSha(buf);
      blobs.set(blobSha, buf);
      let entries = [];
      if (repo.head) {
        const old = commits.get(repo.head);
        entries = (trees.get(old.tree) || []).filter((e) => e.path !== relPath);
      }
      entries.push({ path: relPath, mode: "100644", type: "blob", sha: blobSha });
      const sha = putCommit(key, entries, body.message || "init", repo.head ? [repo.head] : []);
      return json(res, 201, { commit: { sha }, content: { path: relPath, sha: blobSha } });
    }

    mm = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (mm) {
      const key = `${mm[1]}/${mm[2]}`;
      const repo = repos.get(key);
      if (!repo) return notFound(res);
      if (m === "PATCH") {
        if (body.description !== undefined) repo.description = body.description;
        repos.set(key, repo);
        return json(res, 200, { ...repo, name: mm[2], full_name: key });
      }
      return json(res, 200, { ...repo, name: mm[2], full_name: key, html_url: `https://github.com/${key}` });
    }

    if (p === "/user" && m === "GET") return json(res, 200, { login: "tester", name: "Tester", type: "User", total_private_repos: 0 });
    if (p === "/user/repos" && m === "POST") {
      const key = `tester/${body.name}`;
      if (repos.has(key)) return json(res, 422, { message: "Repository creation failed.", errors: [{ message: "name already exists" }] });
      const repo = { private: body.private !== false, default_branch: "main", head: null, description: body.description || "" };
      repos.set(key, repo);
      stats.repoCreates++;
      if (body.auto_init) {
        const buf = Buffer.from("# init\n", "utf8");
        const sha = gitBlobSha(buf);
        blobs.set(sha, buf);
        putCommit(key, [{ path: "README.md", mode: "100644", type: "blob", sha }], "Initial commit", []);
      }
      return json(res, 201, { ...repos.get(key), name: body.name, full_name: key, html_url: `https://github.com/${key}` });
    }
    return notFound(res);
  });

  return {
    blobs, trees, commits, repos, stats,
    async start() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address();
      return `http://127.0.0.1:${port}`;
    },
    async stop() { await new Promise((r) => server.close(r)); },
  };
}

/* ───────── fixture ───────── */

async function makeFixture(root) {
  const a = join(root, "测试插件甲");
  await mkdir(join(a, "locale"), { recursive: true });
  await mkdir(join(a, "assets"), { recursive: true });
  await mkdir(join(a, "node_modules", "junk"), { recursive: true });
  await writeFile(join(a, "package.json"), JSON.stringify({
    name: "dsh-plugin-fixture-a", version: "0.1.0", title: "测试插件甲", type: "module", main: "./index.js",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }, null, 2), "utf8");
  await writeFile(join(a, "cordis.patch.yml"), "- insert:\n    - id: fixture-a\n      name: 'dsh-plugin-fixture-a'\n", "utf8");
  await writeFile(join(a, "index.js"), "export const name = 'fixture-a';\nexport function apply() {}\n", "utf8");
  await writeFile(join(a, "locale", "zh-CN.json"), JSON.stringify({ meta: { title: "测试插件甲" } }, null, 2), "utf8");
  await writeFile(join(a, "assets", "data.txt"), "hello blob\n", "utf8");
  await writeFile(join(a, "node_modules", "junk", "x.js"), "should be excluded\n", "utf8");

  const b = join(root, "插件乙");
  await mkdir(b, { recursive: true });
  await writeFile(join(b, "package.json"), JSON.stringify({ name: "dsh-plugin-fixture-b", version: "2.0.0", title: "插件乙", main: "./index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2), "utf8");
  await writeFile(join(b, "cordis.patch.yml"), "- insert: []\n", "utf8");
  await writeFile(join(b, "index.js"), "export const name = 'fixture-b';\n", "utf8");
  await writeFile(join(b, "README.md"), "# 插件乙\n\n自带 README\n", "utf8");
  return { root, a, b };
}

/* ───────── 主流程 ───────── */

const baseTmp = await mkdtemp(join(tmpdir(), "dsh-gh-selftest-"));
const cfgDir = join(baseTmp, "state");
const pluginRoot = join(baseTmp, "ai插件");
const installRoot = join(baseTmp, "installed");
const profileDir = join(baseTmp, "profile");
await mkdir(cfgDir, { recursive: true });
await mkdir(profileDir, { recursive: true });
await writeFile(join(profileDir, "package.json"), JSON.stringify({ name: "dsh-profile-desktop", dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } }, dependencies: {} }, null, 2), "utf8");

const fx = await makeFixture(pluginRoot);
const mock = makeMock();
const base = await mock.start();
await writeFile(join(cfgDir, "config.json"), JSON.stringify({
  version: 1, owner: "auto", apiBase: base, pluginRoots: [pluginRoot],
  installRoot, profileDir, branch: "main", maxFileMB: 20,
}, null, 2), "utf8");

console.log("— 离线单元 —");
{
  const plugin = { name: "插件发布规范", folder: "插件发布规范" };
  check("中文插件名 → ASCII 仓库名（兜底）", repoNameFor(plugin, {}) === "dsh-plugin", `得到 ${repoNameFor(plugin, {})}`);
  check("ASCII 名保持不变", repoNameFor({ name: "dsh-plugin-panda-auth" }, {}) === "dsh-plugin-panda-auth");
  check("前缀生效", repoNameFor({ name: "dsh-plugin-x" }, { repoPrefix: "dsh" }) === "dsh-dsh-plugin-x");
  check("空 blob sha 正确", gitBlobSha(Buffer.alloc(0)) === "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", gitBlobSha(Buffer.alloc(0)));

  const w = await walkFiles(fx.a, {});
  check("排除 node_modules", !w.files.some((f) => f.rel.includes("node_modules")));
  check("清单 5 个文件", w.files.length === 5, `得到 ${w.files.map((f) => f.rel).join(",")}`);
  check("treeId 稳定", treeIdOf(w.files) === treeIdOf((await walkFiles(fx.a, {})).files));
  const info = await pluginInfo(fx.a);
  check("识别为 DSH 插件", !!info && info.name === "dsh-plugin-fixture-a" && info.title === "测试插件甲");
  const big = await walkFiles(fx.a, { maxFileMB: 0.000001 });
  check("超大文件被跳过", big.files.length === 0 && big.skipped.length > 0);
}

console.log("— 首次 push（自动建私有库） —");
const p1 = await push({ configDir: cfgDir, dirs: [fx.a], token: "test-token" });
const rowA = p1.plugins[0];
check("push 成功", p1.ok && !rowA.error, rowA.error);
check("建了私有库", mock.repos.get("tester/dsh-plugin-fixture-a")?.private === true);
check("新库标记", rowA.newRepo === true);
check("上传了 6 个文件（5 + 自动 README）", rowA.uploaded === 6, String(rowA.uploaded));
check("自动补 README", rowA.addedReadme === true);
{
  const head = mock.repos.get("tester/dsh-plugin-fixture-a").head;
  const commit = mock.commits.get(head);
  const entries = mock.trees.get(commit.tree);
  const paths = entries.map((e) => e.path).sort();
  check("树里文件齐全", JSON.stringify(paths) === JSON.stringify(["README.md", "assets/data.txt", "cordis.patch.yml", "index.js", "locale/zh-CN.json", "package.json"].sort()), paths.join(","));
  const readmeBlob = entries.find((e) => e.path === "README.md").sha;
  const text = mock.blobs.get(readmeBlob).toString("utf8");
  check("生成的 README 带安装说明", text.includes("dsh-plugin-fixture-a") && text.includes("github_upload"));
  const data = entries.find((e) => e.path === "assets/data.txt").sha;
  check("blob 内容原样", mock.blobs.get(data).toString("utf8") === "hello blob\n");
  check("提交信息带插件名", String(commit.message).includes("测试插件甲"));
  const reg = JSON.parse(await readFile(join(cfgDir, "registry.json"), "utf8"));
  check("登记表写入", reg.repos["dsh-plugin-fixture-a"]?.sha === head);
}

console.log("— 二次 push（无改动） —");
{
  const before = mock.stats.commitPosts;
  const p2 = await push({ configDir: cfgDir, dirs: [fx.a], token: "test-token" });
  check("判为无改动", p2.plugins[0].nochange === true, JSON.stringify(p2.plugins[0]));
  check("没有新提交", mock.stats.commitPosts === before);
  check("统计 unchanged=1", p2.stats.unchanged === 1, JSON.stringify(p2.stats));
}

console.log("— 改一个文件 / 删一个文件 —");
{
  const before = mock.stats.commitPosts;
  await writeFile(join(fx.a, "index.js"), "export const name = 'fixture-a-v2';\n", "utf8");
  const p3 = await push({ configDir: cfgDir, dirs: [fx.a], token: "test-token" });
  const r = p3.plugins[0];
  check("只传 1 个 blob", r.uploaded === 1, `uploaded=${r.uploaded}`);
  check("产生新提交", mock.stats.commitPosts === before + 1);
  const head = mock.repos.get("tester/dsh-plugin-fixture-a").head;
  const entries = mock.trees.get(mock.commits.get(head).tree);
  const idx = entries.find((e) => e.path === "index.js").sha;
  check("远端 index.js 已更新", mock.blobs.get(idx).toString("utf8").includes("fixture-a-v2"));

  await rm(join(fx.a, "assets", "data.txt"));
  const p4 = await push({ configDir: cfgDir, dirs: [fx.a], token: "test-token" });
  check("删除被识别", p4.plugins[0].deleted === 1, String(p4.plugins[0].deleted));
  const head2 = mock.repos.get("tester/dsh-plugin-fixture-a").head;
  const entries2 = mock.trees.get(mock.commits.get(head2).tree);
  check("远端树里已没有该文件", !entries2.some((e) => e.path === "assets/data.txt"));
}

console.log("— 自带 README 的插件 —");
{
  const p5 = await push({ configDir: cfgDir, dirs: [fx.b], token: "test-token" });
  check("push 成功", p5.ok && !p5.plugins[0].error, p5.plugins[0].error);
  check("不补 README", p5.plugins[0].addedReadme === false);
  const head = mock.repos.get("tester/dsh-plugin-fixture-b").head;
  const entries = mock.trees.get(mock.commits.get(head).tree);
  const readmeBlob = entries.find((e) => e.path === "README.md").sha;
  check("用的是仓库里的 README", mock.blobs.get(readmeBlob).toString("utf8").includes("自带 README"));
}

console.log("— 公开库加固 / dry-run / 令牌错误 —");
{
  mock.repos.set("tester/dsh-plugin-fixture-a2", { private: false, default_branch: "main", head: null });
  const c = join(pluginRoot, "插件丙");
  await mkdir(c, { recursive: true });
  await writeFile(join(c, "package.json"), JSON.stringify({ name: "dsh-plugin-fixture-a2", version: "1.0.0", main: "./index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }), "utf8");
  await writeFile(join(c, "cordis.patch.yml"), "- insert: []\n", "utf8");
  await writeFile(join(c, "index.js"), "export const name = 'c';\n", "utf8");
  const p6 = await push({ configDir: cfgDir, dirs: [c], token: "test-token" });
  check("拒绝公开库", !p6.ok && /公开库/.test(p6.plugins[0].error), p6.plugins[0].error);

  const d = join(pluginRoot, "插件丁");
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "package.json"), JSON.stringify({ name: "dsh-plugin-dry", version: "1.0.0", main: "./index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }), "utf8");
  await writeFile(join(d, "cordis.patch.yml"), "- insert: []\n", "utf8");
  await writeFile(join(d, "index.js"), "export const name = 'd';\n", "utf8");
  const beforeCreates = mock.stats.repoCreates;
  const p7 = await push({ configDir: cfgDir, dirs: [d], token: "test-token", dryRun: true });
  check("dry-run 不建库", mock.stats.repoCreates === beforeCreates && !mock.repos.has("tester/dsh-plugin-dry"));
  check("dry-run 报出待传文件数", p7.plugins[0].uploaded === 4, String(p7.plugins[0].uploaded));

  const p8 = await push({ configDir: cfgDir, dirs: [d], token: "wrong-token" });
  check("错误令牌 → 明确报错", !p8.ok && /401/.test(p8.errors[0].msg), JSON.stringify(p8.errors));
}

console.log("— 空库兜底（库已存在但没有任何提交） —");
{
  mock.repos.set("tester/dsh-plugin-empty-one", { private: true, default_branch: "main", head: null, description: "" });
  const e = join(pluginRoot, "空库插件");
  await mkdir(e, { recursive: true });
  await writeFile(join(e, "package.json"), JSON.stringify({ name: "dsh-plugin-empty-one", version: "0.3.0", title: "空库插件", main: "./index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }), "utf8");
  await writeFile(join(e, "cordis.patch.yml"), "- insert: []\n", "utf8");
  await writeFile(join(e, "index.js"), "export const name = 'empty-one';\n", "utf8");
  const p = await push({ configDir: cfgDir, dirs: [e], token: "test-token" });
  check("空库 push 成功", p.ok && !p.plugins[0].error, p.plugins[0].error);
  check("走了 Contents 初始化兜底", p.plugins[0].initRepo === true);
  const head = mock.repos.get("tester/dsh-plugin-empty-one").head;
  check("库里有提交了", !!head);
  const entries = mock.trees.get(mock.commits.get(head).tree) || [];
  check("空库树里是 4 个文件（3 + 生成 README）", entries.length === 4, entries.map((x) => x.path).join(","));
  const p2 = await push({ configDir: cfgDir, dirs: [e], token: "test-token" });
  check("再推一次判无改动", p2.plugins[0].nochange === true, JSON.stringify(p2.plugins[0]));
}

console.log("— install（从私有库装回） —");
{
  const bare = join(baseTmp, "bare.git");
  const work = join(baseTmp, "work");
  await mkdir(work, { recursive: true });
  for (const rel of ["package.json", "cordis.patch.yml", "index.js"]) {
    await writeFile(join(work, rel), await readFile(join(fx.b, rel)));
  }
  const git = (...args) => spawnSync("git", args, { cwd: work, encoding: "utf8", windowsHide: true });
  git("init", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  const c = git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init");
  check("本地 git 可用", c.status === 0, String(c.stderr).slice(0, 200));
  spawnSync("git", ["init", "--bare", bare], { encoding: "utf8", windowsHide: true });
  const pusher = spawnSync("git", ["remote", "add", "origin", bare], { cwd: work, encoding: "utf8", windowsHide: true });
  void pusher;
  const pushed = spawnSync("git", ["push", "origin", "main"], { cwd: work, encoding: "utf8", windowsHide: true });
  check("推到本地裸库", pushed.status === 0, String(pushed.stderr).slice(0, 200));

  const r1 = await install({ configDir: cfgDir, repo: "tester/plugin-b", url: "file:///" + bare.replace(/\\/g, "/"), into: installRoot });
  check("install 成功", r1.ok, JSON.stringify(r1.repos));
  const dest = join(installRoot, "plugin-b");
  check("目录已落地", existsSync(join(dest, "package.json")));
  const info = await pluginInfo(dest);
  check("克隆物是 DSH 插件", !!info && info.name === "dsh-plugin-fixture-b", JSON.stringify(info));

  const r2 = await install({ configDir: cfgDir, repo: "tester/plugin-b", url: "file:///" + bare.replace(/\\/g, "/"), into: installRoot });
  check("已存在则跳过", r2.ok && r2.repos[0].skipped === true, JSON.stringify(r2.repos[0]));

  const r3 = await install({ configDir: cfgDir, repo: "tester/plugin-b", url: "file:///" + bare.replace(/\\/g, "/"), into: installRoot, force: true });
  check("force 覆盖成功", r3.ok && r3.repos[0].skipped === false, JSON.stringify(r3.repos[0]));
}

console.log("— link 进 DSH profile —");
{
  const { cfg } = await (await import("./lib.mjs")).loadConfig(cfgDir);
  const lr = await linkPluginToProfile(cfg, join(installRoot, "plugin-b"), { profileDir, noInstall: true });
  check("link 成功", lr.ok, lr.error || lr.note);
  const pkg = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  check("dependencies 指向 link:", String(pkg.dependencies["dsh-plugin-fixture-b"] || "").startsWith("link:"));
  check("bundles 已加入", pkg.dsh.profile.bundles.includes("dsh-plugin-fixture-b"));
  check("原有 bundle 保留", pkg.dsh.profile.bundles.includes("@deepseek-ai/dsh-base"));
  check("需要重启提示", lr.needsRestart === true);
}

await mock.stop();
if (KEEP) console.log(`\n临时目录保留：${baseTmp}`);
else await rm(baseTmp, { recursive: true, force: true }).catch(() => {});

console.log(`\n${fail === 0 ? "✅" : "❌"} 通过 ${pass} · 失败 ${fail}`);
if (fail) {
  for (const f of failures) console.log("   ✗ " + f);
  process.exitCode = 1;
}
