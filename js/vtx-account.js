/*
 * Decrive × Vitual XRing 账户适配
 * - 登录走 API_LOGIN.html（支持登录与创建账户）
 * - 付款走 API_VTXPAY.html（输密码确认）
 * - 成绩写入账户 data（未登录不写）
 * 依赖 https://xsmmc.caldson.us.ci/vtx-sdk.js（暴露 window.VTX）
 */
(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const API_BASE = String(
    window.DECRIVE_VTX_API ||
    params.get("vtx_api") ||
    "https://xsmmc.caldson.us.ci"
  ).replace(/\/+$/, "");
  const WEB_BASE = String(
    window.DECRIVE_VTX_WEB ||
    params.get("vtx_web") ||
    API_BASE
  ).replace(/\/+$/, "");
  const LOGIN_PAGE = `${WEB_BASE}/API_LOGIN.html`;
  const PAY_PAGE = `${WEB_BASE}/API_VTXPAY.html`;
  const BOOST_PRICE = "5.00";
  const BOOST_PARTY = "Decrive 音游";
  const BOOST_DESC = "全 PERFECT 道具 ×1";
  const BOOST_KEY = "decriveBoost";
  const STATS_KEY = "decriveStats";
  const GUEST = { name: "GUEST", money: "0.00" };

  window.DECRIVE_ACCOUNT_BUILD = "1.3.1";

  const state = {
    loggedIn: false,
    login: "",
    username: GUEST.name,
    money: GUEST.money,
    data: {},
    boost: 0,
    busy: false
  };

  const $ = (id) => document.getElementById(id);
  const nodes = {};

  let embed = null;

  const formatMoney = (value) => {
    const amount = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(amount)) return "0.00";
    return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  };

  const toast = (message, type = "success") => {
    const region = $("toastRegion");
    if (!region) return;
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.textContent = message;
    region.append(item);
    window.setTimeout(() => item.remove(), 3400);
  };

  const sdk = () => (typeof window.VTX !== "undefined" ? window.VTX : null);

  const SDK_VERSION = "4.3";

  const loadSdk = () => new Promise((resolve) => {
    if (sdk()) { resolve(true); return; }
    const script = document.createElement("script");
    script.src = `${WEB_BASE}/vtx-sdk.js?v=${SDK_VERSION}`;
    script.async = true;
    script.onload = () => resolve(Boolean(sdk()));
    script.onerror = () => resolve(false);
    document.head.append(script);
  });

  const describeError = (error) => {
    if (!error) return "操作失败，请重试。";
    if (!sdk()) return "无法加载 VTX SDK，请检查网络后刷新页面。";
    if (error instanceof TypeError) {
      if (/is not a function/i.test(String(error.message))) {
        return "VTX SDK 版本过旧，请强制刷新页面（Ctrl+F5）。";
      }
      return `无法连接 VTX 服务（${API_BASE}）。`;
    }
    if (error.code === "invalid_password") return "密码不正确，操作已取消。";
    if (error.code === "insufficient_funds") return error.message || "余额不足。";
    if (error.code === "invalid_credentials") return "登录名或密码不正确。";
    if (error.code === "too_many_requests") return "操作过于频繁，请稍后再试。";
    if (error.code === "not_json" || error.status === 404) return "VTX 服务暂不可用。";
    return error.message || "操作失败，请重试。";
  };

  const normalizeBoost = (value) => {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  };

  const persistBoost = async (count) => {
    const vtx = sdk();
    if (!vtx) return;
    await vtx.setData({ [BOOST_KEY]: count });
  };

  const render = () => {
    if (nodes.name) nodes.name.textContent = state.username;
    if (nodes.meta) {
      const suffix = state.loggedIn ? "已登录" : "未登录";
      nodes.meta.textContent = `${formatMoney(state.money)} VTX · ${suffix}`;
    }
    if (nodes.avatar) nodes.avatar.textContent = (state.username || "G").slice(0, 1).toUpperCase();
    if (nodes.statusText) nodes.statusText.textContent = state.loggedIn ? "VTX 账户已连接" : "离线工作台";
    if (nodes.statusCaption) nodes.statusCaption.textContent = state.loggedIn ? "ONLINE" : "READY";
    if (nodes.action) nodes.action.textContent = state.loggedIn ? "退出" : "登录";

    if (nodes.buy) {
      nodes.buy.disabled = !state.loggedIn || state.busy || !sdk();
      nodes.buy.textContent = state.busy ? "处理中…" : "购买道具";
    }

    if (nodes.shopNote) {
      if (!sdk()) {
        nodes.shopNote.textContent = "VTX 服务未加载，暂时无法使用账户功能。";
      } else if (!state.loggedIn) {
        nodes.shopNote.textContent = "登录后可购买 · 一个谱面内全判定 PERFECT / CERT PERFECT";
      } else if (state.boost > 0) {
        nodes.shopNote.textContent = `已持有 ×${state.boost} · 下一局生效`;
      } else {
        nodes.shopNote.textContent = `${BOOST_PRICE} VTX / 个 · 一个谱面内全判定 PERFECT / CERT PERFECT`;
      }
    }

    if (nodes.badge) {
      if (state.boost > 0) {
        nodes.badge.hidden = false;
        nodes.badge.textContent = `×${state.boost}`;
      } else {
        nodes.badge.hidden = true;
        nodes.badge.textContent = "";
      }
    }

    const profile = $("vtxProfile");
    if (profile) profile.classList.toggle("guest", !state.loggedIn);
  };

  const applyAccount = ({ login, username, money, data }) => {
    state.loggedIn = true;
    state.login = login || "";
    state.username = String(username || login || GUEST.name);
    state.money = String(money ?? "0.00");
    state.data = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    state.boost = normalizeBoost(state.data[BOOST_KEY]);
    render();
  };

  const resetGuest = () => {
    state.loggedIn = false;
    state.login = "";
    state.username = GUEST.name;
    state.money = GUEST.money;
    state.data = {};
    state.boost = 0;
    render();
  };

  /* ---------- 弹窗（API_LOGIN.html / API_VTXPAY.html） ---------- */

  const allowedOrigins = () => {
    const list = new Set();
    try { list.add(new URL(WEB_BASE).origin); } catch (error) { /* 忽略 */ }
    try { list.add(new URL(API_BASE).origin); } catch (error) { /* 忽略 */ }
    return list;
  };

  const closeEmbed = () => {
    if (!embed) return;
    embed.root.remove();
    embed = null;
  };

  const openEmbed = (url, title) => {
    closeEmbed();

    const root = document.createElement("div");
    root.className = "vtx-embed";

    const card = document.createElement("div");
    card.className = "vtx-embed-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");

    const head = document.createElement("header");
    head.className = "vtx-embed-head";

    const heading = document.createElement("strong");
    heading.textContent = title;

    const actions = document.createElement("div");
    actions.className = "vtx-embed-actions";

    const external = document.createElement("a");
    external.href = url;
    external.target = "_blank";
    external.rel = "noreferrer";
    external.textContent = "在新标签打开";

    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    close.addEventListener("click", closeEmbed);

    actions.append(external, close);
    head.append(heading, actions);

    const frame = document.createElement("iframe");
    frame.src = url;
    frame.title = title;
    frame.setAttribute("allow", "clipboard-write");

    card.append(head, frame);
    root.append(card);
    root.addEventListener("click", (event) => {
      if (event.target === root) closeEmbed();
    });

    document.body.append(root);
    embed = { root, frame };
    return embed;
  };

  const embedUrl = (base, extra) => {
    const query = new URLSearchParams({ api: API_BASE, embed: "1", ...extra });
    return `${base}?${query.toString()}`;
  };

  const startLogin = () => {
    if (!sdk()) {
      toast("VTX 服务未加载，请检查网络后刷新页面。", "error");
      return;
    }
    openEmbed(embedUrl(LOGIN_PAGE), "登录 / 创建账户");
  };

  const startBuy = () => {
    if (!sdk()) {
      toast("VTX 服务未加载，请检查网络后刷新页面。", "error");
      return;
    }
    if (!state.loggedIn) {
      startLogin();
      return;
    }
    openEmbed(embedUrl(PAY_PAGE, {
      type: "payment",
      party: BOOST_PARTY,
      amount: BOOST_PRICE,
      description: BOOST_DESC,
      lock: "1",
      close: "1"
    }), "付款确认");
  };

  const handleLoginResult = result => {
    const vtx = sdk();
    if (!vtx || !result || !result.account) return;
    if (result.token && typeof vtx.setToken === "function") {
      vtx.setToken(result.token);
    }
    applyAccount({
      login: result.login,
      username: result.account.username,
      money: result.account.money,
      data: result.account.data
    });
    toast(result.created ? `账户已创建：${state.username}` : `已登录：${state.username}`);
  };

  const handlePayResult = async (data) => {
    const account = data.account || {};
    state.money = String(account.money ?? state.money);
    if (account.data && typeof account.data === "object") state.data = account.data;

    const next = normalizeBoost(state.boost) + 1;
    state.boost = next;
    render();

    try {
      await persistBoost(next);
    } catch (error) {
      /* 写入失败不影响本局使用，下次刷新以服务端为准 */
    }

    render();
    toast(`购买成功，已扣除 ${BOOST_PRICE} VTX（道具 ×${next}）`);
  };

  window.addEventListener("message", (event) => {
    const origins = allowedOrigins();
    if (!origins.has(event.origin)) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "vtx-login" && data.ok && data.result) {
      handleLoginResult(data.result);
      // 留一点时间让内嵌页显示「登录成功」，随后自动收起
      window.setTimeout(closeEmbed, 900);
      return;
    }

    if (data.type === "vtx-pay" && data.ok) {
      handlePayResult(data);
      closeEmbed();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && embed) closeEmbed();
  });

  const logout = () => {
    const vtx = sdk();
    if (vtx) vtx.logout();
    resetGuest();
    toast("已退出 VTX 账户");
  };

  /* ---------- 对外接口 ---------- */

  const persistScore = async (record) => {
    const vtx = sdk();
    if (!vtx || !state.loggedIn) return false;

    const previous = state.data[STATS_KEY];
    const stats = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
    const charts = stats.charts && typeof stats.charts === "object" && !Array.isArray(stats.charts) ? stats.charts : {};

    const id = String(record.chartId || "unknown");
    const prior = charts[id] && typeof charts[id] === "object" ? charts[id] : {};
    const score = Math.max(0, Math.floor(Number(record.score) || 0));

    charts[id] = {
      title: String(record.chartTitle || prior.title || id),
      best: Math.max(Number(prior.best) || 0, score),
      last: score,
      bestCombo: Math.max(Number(prior.bestCombo) || 0, Math.floor(Number(record.combo) || 0)),
      grade: String(record.grade || prior.grade || ""),
      plays: (Number(prior.plays) || 0) + 1,
      boost: Boolean(record.boost),
      updatedAt: String(record.time || "")
    };

    const payload = {
      charts,
      last: {
        chartId: id,
        title: charts[id].title,
        score,
        combo: charts[id].bestCombo,
        grade: charts[id].grade,
        boost: charts[id].boost,
        time: charts[id].updatedAt
      }
    };

    try {
      await vtx.setData({ [STATS_KEY]: payload });
      state.data[STATS_KEY] = payload;
      return true;
    } catch (error) {
      toast(`成绩同步失败：${describeError(error)}`, "error");
      return false;
    }
  };

  const consumeBoost = async () => {
    if (state.boost <= 0) return false;
    state.boost -= 1;
    render();
    try {
      await persistBoost(state.boost);
    } catch (error) {
      /* 忽略：下次刷新以服务端为准 */
    }
    return true;
  };

  const isBoostActive = () => state.loggedIn && state.boost > 0;

  const getState = () => ({ ...state });

  /* ---------- 初始化 ---------- */

  const bind = () => {
    nodes.name = $("vtxName");
    nodes.meta = $("vtxMeta");
    nodes.avatar = $("vtxAvatar");
    nodes.action = $("vtxAccountAction");
    nodes.buy = $("vtxBuyBoost");
    nodes.shopNote = $("vtxShopNote");
    nodes.badge = $("vtxBoostBadge");
    nodes.statusText = $("accountStatusText");
    nodes.statusCaption = $("accountStatusCaption");

    if (nodes.action) {
      nodes.action.addEventListener("click", () => {
        if (state.loggedIn) logout();
        else startLogin();
      });
    }

    if (nodes.buy) nodes.buy.addEventListener("click", startBuy);
  };

  const init = async () => {
    bind();
    render();

    const loaded = await loadSdk();
    render();

    if (!loaded) {
      return;
    }

    const vtx = sdk();
    vtx.configure({ baseUrl: API_BASE });

    if (!vtx.isLoggedIn()) {
      render();
      return;
    }

    try {
      const result = await vtx.me();
      applyAccount({
        login: result.login,
        username: result.account.username,
        money: result.account.money,
        data: result.account.data
      });
    } catch (error) {
      vtx.logout();
      resetGuest();
    }
  };

  window.DecriveAccount = {
    init,
    getState,
    isBoostActive,
    consumeBoost,
    submitScore: persistScore,
    openLogin: startLogin,
    buyBoost: startBuy,
    logout
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
