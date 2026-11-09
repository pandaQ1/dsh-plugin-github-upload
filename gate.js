/**
 * GitHub 门房（gate）—— 登录与令牌
 *
 * 目标：新机器上装完插件，不靠人肉拷 token，也能拿到一个能读私有库的 GitHub 凭证。
 *
 * 两条通道：
 *   1. Device Flow（推荐）：OAuth App 的 client_id → 设备码 → 浏览器里点授权 → 轮询换 token。
 *      全程不需要 client secret，client_id 本来就是公开信息，可以写进公开库。
 *   2. PAT 兜底：直接把个人访问令牌粘进来（不建 OAuth App 时的最短路径）。
 *
 * 令牌落盘位置与既有插件完全一致：<cfgDir>/token.txt
 * （cfgDir 默认 ~/.dsh/github-plugin-upload），所以 github_upload / harness-butler
 * 一行都不用改就能用上这次登录的结果。
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  abs, configDirOf, expandHome, loadConfig, makeApi, maskToken, readJson, resolveToken, saveToken, whoAmI, writeJson,
} from "./assets/lib.mjs";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const STATE_FILE = "login-state.json";
const DEFAULT_SCOPE = "repo";

/** 进程内的登录流程；一个进程同时只跑一条。 */
let flow = null;

/* ───────────────── 基础 ───────────────── */

export function openExternal(url) {
  try {
    const [cmd, args] = process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function publicFlow() {
  if (flow === null) return null;
  const { status, userCode, verificationUri, expiresAt, intervalMs, scope, login, error, startedAt } = flow;
  return {
    status,
    userCode,
    verificationUri,
    expiresAt,
    intervalSec: Math.round(intervalMs / 1000),
    scope,
    login: login ?? "",
    error: error ?? "",
    startedAt,
  };
}

async function persist(cfgDir) {
  try {
    await writeJson(join(cfgDir, STATE_FILE), publicFlow() ?? { status: "idle" });
  } catch {
    /* 状态文件只是给界面看的，写不进去不影响登录 */
  }
}

function stopFlow() {
  if (flow === null) return;
  if (flow.timer !== undefined) clearTimeout(flow.timer);
  flow = null;
}

export function cancelLogin({ cfgDir } = {}) {
  stopFlow();
  if (cfgDir) void persist(configDirOf(cfgDir));
  return { ok: true, summary: "已取消登录流程" };
}

export function disposeLogin() {
  stopFlow();
}

/* ───────────────── Device Flow ───────────────── */

async function requestDeviceCode(clientId, scope) {
  const body = new URLSearchParams({ client_id: clientId, scope });
  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await response.json().catch(() => ({}));
  if (json.device_code === undefined) {
    throw new Error(json.error_description || json.error || `GitHub 没有返回设备码（HTTP ${response.status}）`);
  }
  return json;
}

async function exchange(clientId, deviceCode) {
  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const response = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return response.json().catch(() => ({}));
}

/**
 * 起一条设备码登录。返回设备码与授权地址；真正的轮询在后台跑，
 * 由 loginStatus 汇报进度（界面每 3 秒拉一次）。
 */
export async function startLogin({ cfgDir: cfgDirArg, clientId: clientIdArg, scope: scopeArg, openBrowser = true } = {}) {
  const { cfgDir, cfg } = await loadConfig(cfgDirArg);
  const clientId = String(clientIdArg ?? cfg.oauthClientId ?? "").trim();
  const scope = String(scopeArg ?? cfg.oauthScope ?? DEFAULT_SCOPE).trim() || DEFAULT_SCOPE;

  if (clientId.length === 0) {
    return {
      ok: false,
      summary: "还没有 OAuth App 的 client_id",
      detail: [
        "在 GitHub → Settings → Developer settings → OAuth Apps → New OAuth App 建一个：",
        "  · Application name 随便填（如 DSH Gate）",
        "  · Homepage URL 填 http://127.0.0.1",
        "  · 建好后进入该 App 设置，勾上 Enable Device Flow",
        "然后把它的 Client ID 填进来：github_upload { action: \"init\", clientId: \"<Client ID>\" }",
        "不想建 OAuth App 也可以直接用令牌：github_upload { action: \"auth\", token: \"<PAT>\" }",
      ].join("\n"),
    };
  }

  stopFlow();
  const dc = await requestDeviceCode(clientId, scope);
  const intervalMs = Math.max(5, Number(dc.interval) || 5) * 1000;
  flow = {
    status: "pending",
    clientId,
    scope,
    deviceCode: dc.device_code,
    userCode: dc.user_code,
    verificationUri: dc.verification_uri || "https://github.com/login/device",
    expiresAt: Date.now() + (Number(dc.expires_in) || 900) * 1000,
    intervalMs,
    startedAt: Date.now(),
    error: "",
    timer: undefined,
  };
  await persist(cfgDir);

  const opened = openBrowser ? openExternal(flow.verificationUri) : false;
  schedule(cfgDir);

  return {
    ok: true,
    status: "pending",
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    expiresAt: flow.expiresAt,
    intervalSec: Math.round(intervalMs / 1000),
    opened,
    summary: `设备码 ${flow.userCode}：在浏览器里输入并授权（${Math.round(((flow.expiresAt - Date.now()) / 1000) / 60)} 分钟内有效）`,
    detail: opened
      ? `已尝试打开 ${flow.verificationUri}，输入上面的设备码即可`
      : `请手动打开 ${flow.verificationUri} 并输入设备码 ${flow.userCode}`,
  };
}

function schedule(cfgDir) {
  if (flow === null) return;
  const current = flow;
  current.timer = setTimeout(async () => {
    if (flow !== current) return;
    if (Date.now() > current.expiresAt) {
      current.status = "expired";
      current.error = "设备码已过期，请重新登录";
      stopFlow();
      await persist(cfgDir);
      return;
    }
    try {
      const result = await exchange(current.clientId, current.deviceCode);
      if (flow !== current) return;
      if (typeof result.access_token === "string" && result.access_token.length > 0) {
        await saveToken(cfgDir, result.access_token);
        let login = "";
        try {
          const me = await whoAmI(makeApi({ token: result.access_token, timeoutMs: 12000 }));
          login = me.login ?? "";
        } catch {
          /* 拿不到昵称不影响登录成功 */
        }
        current.status = "success";
        current.login = login;
        stopFlow();
        await persist(cfgDir);
        return;
      }
      const code = String(result.error ?? "");
      if (code === "authorization_pending") {
        /* 用户还没点，继续等 */
      } else if (code === "slow_down") {
        current.intervalMs += (Number(result.interval) || 5) * 1000;
      } else if (code === "expired_token") {
        current.status = "expired";
        current.error = "设备码已过期，请重新登录";
        stopFlow();
        await persist(cfgDir);
        return;
      } else {
        current.status = "failed";
        current.error = result.error_description || code || "授权失败";
        stopFlow();
        await persist(cfgDir);
        return;
      }
    } catch (error) {
      if (flow !== current) return;
      current.lastError = String(error?.message ?? error);
    }
    schedule(cfgDir);
  }, current.intervalMs);
  current.timer?.unref?.();
}

/* ───────────────── 状态 / 退出 ───────────────── */

function tokenFilePath(cfg) {
  return abs(expandHome(cfg.tokenFile || join(configDirOf(""), "token.txt")));
}

/** 给界面和工具用的完整状态：登录流程 + 令牌是否可用。 */
export async function loginStatus({ cfgDir: cfgDirArg, probe = true } = {}) {
  const { cfgDir, cfg } = await loadConfig(cfgDirArg);
  const memory = publicFlow();
  const persisted = memory ?? (await readJson(join(cfgDir, STATE_FILE)));

  const resolved = await resolveToken(cfgDir, cfg);
  let who = null;
  let probeError = "";
  if (resolved.token && probe) {
    try {
      who = await whoAmI(makeApi({ token: resolved.token, apiBase: cfg.apiBase, timeoutMs: 12000 }));
    } catch (error) {
      probeError = String(error?.message ?? error);
    }
  }

  return {
    ok: true,
    summary: who?.login
      ? `已登录 @${who.login}（${resolved.source}）`
      : persisted?.status === "pending"
        ? `等待授权：设备码 ${persisted.userCode ?? ""}`
        : resolved.token
          ? `有令牌但校验失败：${probeError || "未知原因"}`
          : "未登录",
    cfgDir,
    flow: persisted ?? { status: "idle" },
    clientId: String(cfg.oauthClientId ?? ""),
    scope: String(cfg.oauthScope ?? DEFAULT_SCOPE),
    token: {
      present: Boolean(resolved.token),
      source: resolved.source ?? "",
      masked: resolved.token ? maskToken(resolved.token) : "",
      login: who?.login ?? "",
      name: who?.name ?? "",
      scopes: who?.scopes ?? [],
      privateRepos: who?.privateRepos ?? null,
      error: probeError,
      file: tokenFilePath(cfg),
    },
  };
}

/** 退出登录：删掉 token.txt（环境变量里的令牌删不掉，会明确说明）。 */
export async function logout({ cfgDir: cfgDirArg } = {}) {
  const { cfgDir, cfg } = await loadConfig(cfgDirArg);
  stopFlow();
  const file = tokenFilePath(cfg);
  let removed = false;
  try {
    await rm(file, { force: true });
    removed = true;
  } catch {
    removed = false;
  }
  await persist(cfgDir);
  const fromEnv = (cfg.tokenEnv ?? []).filter((name) => typeof process.env[name] === "string" && process.env[name].trim() !== "");
  return {
    ok: true,
    summary: removed ? "已删除本地令牌" : "本地没有令牌文件",
    detail: fromEnv.length > 0
      ? `注意：环境变量里还有令牌（${fromEnv.join(", ")}），它们优先于文件，要换账号得先清掉。\n文件：${file}`
      : `文件：${file}`,
  };
}
