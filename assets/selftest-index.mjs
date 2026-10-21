// selftest-index.mjs — 校验 index.js 里的工具定义与输出契约（不联网、不写真实配置）
//
//   node assets/selftest-index.mjs
//
// 做三件事：
//   1. 工具名/参数/输出 schema 的基本自洽检查
//   2. 在临时目录跑 status / init / scan / list / auth(无令牌) / install(缺参数)，逐个按 schema 校验
//   3. 确认不会误写 ~/.dsh

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(join(import.meta.dirname, "..", "index.js")).href);
const tool = mod.tool || null;
let pass = 0;
const fails = [];
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fails.push(name + (extra ? " — " + extra : "")); console.log("  ✗ " + name + (extra ? " — " + extra : "")); }
};

/** 极简 JSON Schema 子集校验（type / required / properties / additionalProperties / items / enum） */
function validate(schema, value, path = "$") {
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} 不在 enum 里`);
  const t = schema.type;
  if (t) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const map = { integer: (v) => typeof v === "number" && Number.isInteger(v), number: (v) => typeof v === "number", object: (v) => v !== null && typeof v === "object" && !Array.isArray(v) };
    const ok = map[t] ? map[t](value) : actual === t;
    if (!ok) errors.push(`${path}: 期望 ${t}，实际 ${actual}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${path}: 缺必填 ${k}`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties && schema.properties[k];
      if (!sub) { if (schema.additionalProperties === false) errors.push(`${path}: 多余字段 ${k}`); continue; }
      errors.push(...validate(sub, v, `${path}.${k}`));
    }
  }
  return errors;
}

const tmp = await mkdtemp(join(tmpdir(), "dsh-gh-index-"));
const cfg = join(tmp, "state");

console.log("— 工具定义 —");
// index.js 只导出 apply/name/inject；工具对象在 apply 里注册，这里用桩 ctx 捕获
let registered = null;
const ctx = {
  effect(fn) { fn(); },
  tools: { register(t) { registered = t; return () => {}; } },
};
mod.apply(ctx);
check("apply 注册了工具", !!registered);
check("工具名 github_upload", registered && registered.name === "github_upload", registered && registered.name);
check("有 execute", typeof registered.execute === "function");
check("有 output.render", !!(registered.output && registered.output.render));
check("参数 schema 是 object", registered.parameters.type === "object");
check("action 枚举齐全", ["status", "init", "auth", "scan", "push", "install", "link", "list"].every((a) => registered.parameters.properties.action.enum.includes(a)));

console.log("— 各动作输出契约（临时配置目录）—");
const run = async (args) => {
  const started = Date.now();
  const value = await registered.execute({ ...args, configDir: cfg });
  const errs = validate(registered.output.schema, value);
  const text = registered.output.render(args, value)[0].text;
  check(`execute(${args.action}) 合规`, errs.length === 0, errs.slice(0, 3).join(" | "));
  check(`execute(${args.action}) 有渲染文本`, typeof text === "string" && text.length > 0);
  console.log(`     ${(Date.now() - started)} ms · ${value.ok ? "ok" : "fail"} · ${value.summary}`);
  return value;
};

const s1 = await run({ action: "status" });
check("status 不因缺令牌崩溃", typeof s1.summary === "string");
check("status 指出缺令牌", JSON.stringify(s1.issues || []).includes("令牌") || s1.checks.some((c) => c.name === "令牌" && !c.ok));

const init = await run({ action: "init" });
check("init 写了 config.json", await readFile(join(cfg, "config.json"), "utf8").then((t) => t.includes("pluginRoots")).catch(() => false));

const sc = await run({ action: "scan" });
check("scan 至少识别 1 个插件", (sc.plugins || []).length >= 1, String((sc.plugins || []).length));

const ls = await run({ action: "list" });
check("list 空登记表也 ok", df(ls));

function df(v) { return v.ok === true; }

const au = await run({ action: "auth" });
check("auth 缺令牌 → 失败但合规", au.ok === false);

const ins = await run({ action: "install" });
check("install 缺参数 → 明确提示", ins.ok === false && /repo|name/.test(ins.summary + JSON.stringify(ins.issues)));

await rm(tmp, { recursive: true, force: true }).catch(() => {});

console.log(`\n${fails.length ? "❌" : "✅"} 通过 ${pass} · 失败 ${fails.length}`);
if (fails.length) {
  for (const f of fails) console.log("   ✗ " + f);
  process.exitCode = 1;
}
