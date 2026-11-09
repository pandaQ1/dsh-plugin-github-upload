/**
 * GitHub 门房（Client 半边）
 *
 * 设置页的「GitHub 登录」卡片：
 *   · 没登录 → 一键设备码登录（大字显示 user_code、复制、打开授权页、轮询状态）
 *   · 不想建 OAuth App → 直接粘 PAT
 *   · 已登录 → 显示 @login / scopes / 私有库数，可重新登录或退出
 *
 * 真正的令牌只在宿主侧落盘（<cfgDir>/token.txt），浏览器这一半从来看不到它。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-github-gate",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const { jsx, jsxs } = require("react/jsx-runtime");
    const react = require("react");

    const NS = "github-gate";
    const BASE = "/dsh-github-gate";
    const POLL_MS = 3000;

    const CSS = [
      ".gg-root{display:flex;flex-direction:column;gap:12px;max-width:760px}",
      ".gg-desc{font-size:13px;line-height:1.6;opacity:.75;margin:0}",
      ".gg-card{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:12px}",
      ".gg-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
      ".gg-btn{border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer}",
      ".gg-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 8%,transparent)}",
      ".gg-btn:disabled{opacity:.45;cursor:default}",
      ".gg-btn-primary{border-color:color-mix(in srgb,#3b82f6 60%,transparent);color:#3b82f6}",
      ".gg-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;letter-spacing:6px;font-weight:600;padding:10px 14px;border-radius:10px;border:1px dashed color-mix(in srgb,currentColor 30%,transparent);user-select:all}",
      ".gg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;opacity:.8}",
      ".gg-input{flex:1 1 260px;min-width:200px;padding:6px 10px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font-size:13px}",
      ".gg-notice{font-size:12.5px;line-height:1.6;border-radius:8px;padding:8px 10px;white-space:pre-wrap}",
      ".gg-ok{background:color-mix(in srgb,#22c55e 12%,transparent);border:1px solid color-mix(in srgb,#22c55e 35%,transparent)}",
      ".gg-warn{background:color-mix(in srgb,#f59e0b 12%,transparent);border:1px solid color-mix(in srgb,#f59e0b 35%,transparent)}",
      ".gg-err{background:color-mix(in srgb,#ef4444 12%,transparent);border:1px solid color-mix(in srgb,#ef4444 35%,transparent)}",
      ".gg-h{font-size:13px;font-weight:600}",
      ".gg-sub{font-size:12px;opacity:.65}",
    ].join("");

    function mountStyle(id, css) {
      if (document.getElementById(id) !== null) return;
      const tag = document.createElement("style");
      tag.id = id;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    async function request(path, init = {}, timeoutMs = 30000) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(path, { credentials: "include", ...init, signal: controller.signal });
        const text = await response.text();
        let payload;
        try {
          payload = text.length === 0 ? {} : JSON.parse(text);
        } catch {
          throw new Error(`宿主返回了非 JSON（HTTP ${response.status}）`);
        }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
        return payload;
      } catch (error) {
        if (error?.name === "AbortError") throw new Error(`请求超时（${timeoutMs / 1000}s）`);
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
    }

    function post(path, body) {
      return request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    }

    function GateSection() {
      const [status, setStatus] = react.useState(null);
      const [busy, setBusy] = react.useState("");
      const [notice, setNotice] = react.useState(null);
      const [pat, setPat] = react.useState("");
      const [clientId, setClientId] = react.useState("");

      const flow = status?.flow ?? { status: "idle" };
      const token = status?.token ?? { present: false };
      const pending = flow.status === "pending";

      const refresh = react.useCallback(async () => {
        try {
          const next = await request(`${BASE}/status`);
          setStatus(next);
          if (typeof next?.clientId === "string" && next.clientId !== "" && clientId === "") setClientId(next.clientId);
          return next;
        } catch (error) {
          setNotice({ kind: "err", text: `读不到登录状态：${String(error?.message ?? error)}` });
          return null;
        }
      }, [clientId]);

      react.useEffect(() => {
        void refresh();
      }, [refresh]);

      // 设备码登录进行中：每 3 秒问一次宿主；成功/失败即停
      react.useEffect(() => {
        if (!pending) return undefined;
        const timer = window.setInterval(async () => {
          const next = await refresh();
          if (next && next.flow?.status !== "pending") {
            window.clearInterval(timer);
            if (next.flow?.status === "success") {
              setNotice({ kind: "ok", text: `登录成功${next.token?.login ? "：@" + next.token.login : ""}` });
            } else if (next.flow?.status === "failed" || next.flow?.status === "expired") {
              setNotice({ kind: "err", text: next.flow?.error || "登录未完成" });
            }
          }
        }, POLL_MS);
        return () => window.clearInterval(timer);
      }, [pending, refresh]);

      const startLogin = async () => {
        setBusy("login");
        setNotice(null);
        try {
          const result = await post(`${BASE}/login`, { clientId: clientId.trim() || undefined, openBrowser: true });
          if (result.ok === false) {
            setNotice({ kind: "warn", text: [result.summary, result.detail].filter(Boolean).join("\n") });
          } else {
            setNotice({ kind: "ok", text: result.detail || result.summary || "已生成设备码" });
          }
          await refresh();
        } catch (error) {
          setNotice({ kind: "err", text: String(error?.message ?? error) });
        } finally {
          setBusy("");
        }
      };

      const cancelLogin = async () => {
        setBusy("cancel");
        try {
          await post(`${BASE}/login-cancel`);
          setNotice({ kind: "warn", text: "已取消登录" });
          await refresh();
        } catch (error) {
          setNotice({ kind: "err", text: String(error?.message ?? error) });
        } finally {
          setBusy("");
        }
      };

      const savePat = async () => {
        const value = pat.trim();
        if (value === "") {
          setNotice({ kind: "warn", text: "先把令牌粘进输入框" });
          return;
        }
        setBusy("pat");
        try {
          const result = await post(`${BASE}/token`, { token: value });
          setPat("");
          setNotice({ kind: "ok", text: `令牌已保存${result?.login ? "：@" + result.login : ""}` });
          await refresh();
        } catch (error) {
          setNotice({ kind: "err", text: String(error?.message ?? error) });
        } finally {
          setBusy("");
        }
      };

      const doLogout = async () => {
        setBusy("logout");
        try {
          const result = await post(`${BASE}/logout`);
          setNotice({ kind: "warn", text: [result.summary, result.detail].filter(Boolean).join("\n") });
          await refresh();
        } catch (error) {
          setNotice({ kind: "err", text: String(error?.message ?? error) });
        } finally {
          setBusy("");
        }
      };

      const copyCode = async () => {
        try {
          await navigator.clipboard.writeText(flow.userCode ?? "");
          setNotice({ kind: "ok", text: "设备码已复制" });
        } catch {
          setNotice({ kind: "warn", text: "复制失败，手动选中上面的设备码即可" });
        }
      };

      const openPage = () => {
        const url = flow.verificationUri || "https://github.com/login/device";
        window.open(url, "_blank", "noopener");
      };

      const signedIn = token.present === true;

      return jsxs("div", {
        className: "gg-root",
        children: [
          jsx("p", {
            className: "gg-desc",
            children: signedIn
              ? "已登录。这个令牌放在宿主侧，管家、插件上传、插件安装都直接用它。"
              : "还没登录。设备码登录最省事：点一下，浏览器里输 6~8 位设备码并授权，宿主会自动完成登录。",
          }),

          jsxs("div", {
            className: "gg-card",
            children: [
              jsxs("div", {
                className: "gg-row",
                children: [
                  jsx("span", { className: "gg-h", children: signedIn ? "已连接 GitHub" : "登录 GitHub" }),
                  signedIn
                    ? jsx("span", { className: "gg-sub", children: `@${token.login || "（未知账号）"}${(token.scopes ?? []).length ? " · " + token.scopes.join(",") : ""}${token.privateRepos !== null ? " · 私有库 " + token.privateRepos : ""}` })
                    : null,
                ],
              }),

              signedIn
                ? jsx("div", {
                    className: "gg-row",
                    children: [
                      jsx("button", { className: "gg-btn", disabled: busy !== "", onClick: () => void refresh(), children: "刷新状态" }),
                      jsx("button", { className: "gg-btn", disabled: busy !== "", onClick: () => void doLogout(), children: busy === "logout" ? "退出中…" : "退出登录" }),
                    ],
                  })
                : jsxs("div", {
                    style: { display: "flex", flexDirection: "column", gap: "12px" },
                    children: [
                      jsxs("div", {
                        className: "gg-row",
                        children: [
                          jsx("input", {
                            className: "gg-input",
                            placeholder: "OAuth App 的 Client ID（可选，留空则只能用下面的 PAT）",
                            value: clientId,
                            onChange: (event) => setClientId(event.target.value),
                          }),
                          jsx("button", {
                            className: "gg-btn gg-btn-primary",
                            disabled: busy !== "" || pending,
                            onClick: () => void startLogin(),
                            children: busy === "login" ? "生成设备码…" : pending ? "等待授权…" : "设备码登录",
                          }),
                        ],
                      }),

                      pending
                        ? jsxs("div", {
                            style: { display: "flex", flexDirection: "column", gap: "8px" },
                            children: [
                              jsx("div", { className: "gg-code", children: flow.userCode }),
                              jsx("div", {
                                className: "gg-row",
                                children: [
                                  jsx("button", { className: "gg-btn gg-btn-primary", onClick: () => void copyCode(), children: "复制设备码" }),
                                  jsx("button", { className: "gg-btn", onClick: openPage, children: "打开 GitHub 授权页" }),
                                  jsx("button", { className: "gg-btn", disabled: busy !== "", onClick: () => void cancelLogin(), children: "取消" }),
                                ],
                              }),
                              jsx("div", {
                                className: "gg-sub",
                                children: `在 github.com/login/device 输入上面的设备码并授权，本页每 ${POLL_MS / 1000} 秒自动检查一次。剩余约 ${Math.max(0, Math.round(((flow.expiresAt ?? 0) - Date.now()) / 60000))} 分钟。`,
                              }),
                            ],
                          })
                        : null,

                      jsxs("div", {
                        className: "gg-row",
                        children: [
                          jsx("input", {
                            className: "gg-input",
                            type: "password",
                            placeholder: "或直接粘 Personal Access Token（classic 勾 repo / fine-grained 给 Contents 读写）",
                            value: pat,
                            onChange: (event) => setPat(event.target.value),
                          }),
                          jsx("button", { className: "gg-btn", disabled: busy !== "", onClick: () => void savePat(), children: busy === "pat" ? "校验中…" : "保存令牌" }),
                        ],
                      }),

                      jsx("p", {
                        className: "gg-desc",
                        children: "没有 OAuth App？去 GitHub → Settings → Developer settings → OAuth Apps 新建一个，勾上 Enable Device Flow，把 Client ID 填到上面。",
                      }),
                    ],
                  }),
            ],
          }),

          notice === null
            ? null
            : jsx("div", {
                className: `gg-notice ${notice.kind === "ok" ? "gg-ok" : notice.kind === "warn" ? "gg-warn" : "gg-err"}`,
                children: notice.text,
              }),
        ],
      });
    }

    const inject = ["slots"];

    function apply(ctx) {
      mountStyle(`${NS}/section.css`, CSS);
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "github-gate",
        order: 62,
        label: () => "GitHub 登录",
      }, GateSection));
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
