/*
 * Decrive × Vitual XRing 账户适配
 * - 登录后侧边栏显示 VTX 用户名与余额
 * - 成绩写入账户 data（未登录不写）
 * - 5.00 VTX 购买「全 PERFECT」道具，一个谱面内全部判定为 CERT PERFECT
 * 依赖 https://xsmmc.caldson.us.ci/vtx-sdk.js（暴露 window.VTX）
 */
(() => {
  "use strict";

  const API_BASE = String(
    window.DECRIVE_VTX_API ||
    new URLSearchParams(window.location.search).get("vtx_api") ||
    "https://xsmmc.caldson.us.ci"
  ).replace(/\/+$/, "");
  const BOOST_PRICE = "5.00";
  const BOOST_PARTY = "Decrive 音游";
  const BOOST_DESC = "全 PERFECT 道具 ×1";
  const BOOST_KEY = "decriveBoost";
  const STATS_KEY = "decriveStats";
  const GUEST = { name: "GUEST", money: "0.00" };

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

  let modalSubmit = null;

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

  /* ---------- 弹窗 ---------- */

  const closeModal = () => {
    const modal = $("vtxModal");
    if (!modal) return;
    modal.hidden = true;
    modalSubmit = null;
    const message = $("vtxModalMessage");
    if (message) {
      message.textContent = "";
      message.className = "vtx-modal-message";
    }
  };

  const setModalMessage = (text, ok = false) => {
    const message = $("vtxModalMessage");
    if (!message) return;
    message.textContent = text || "";
    message.className = ok ? "vtx-modal-message ok" : "vtx-modal-message";
  };

  const openModal = ({ title, desc, mode, submitLabel, onSubmit }) => {
    const modal = $("vtxModal");
    if (!modal) return;

    $("vtxModalTitle").textContent = title;
    $("vtxModalDesc").textContent = desc || "";
    $("vtxModalSubmit").textContent = submitLabel || "确定";

    const loginField = $("vtxLoginField");
    const passwordLabel = $("vtxPasswordLabel");
    if (loginField) loginField.hidden = mode !== "login";
    if (passwordLabel) passwordLabel.textContent = mode === "login" ? "密码" : "密码（确认支付）";

    const password = $("vtxLoginPassword");
    if (password) password.value = "";
    if (mode === "login") {
      const name = $("vtxLoginName");
      if (name) name.value = "";
    }

    setModalMessage("");
    modal.hidden = false;
    modalSubmit = onSubmit;

    const focus = mode === "login" ? $("vtxLoginName") : $("vtxLoginPassword");
    if (focus) window.setTimeout(() => focus.focus(), 40);
  };

  /* ---------- 操作 ---------- */

  const doLogin = async () => {
    const vtx = sdk();
    if (!vtx) {
      setModalMessage("无法加载 VTX SDK，请检查网络后刷新页面。");
      return;
    }

    const login = ($("vtxLoginName").value || "").trim();
    const password = $("vtxLoginPassword").value || "";

    if (!login || !password) {
      setModalMessage("请填写登录账户名和密码。");
      return;
    }

    $("vtxModalSubmit").disabled = true;
    setModalMessage("正在登录…", true);

    try {
      const result = await vtx.login(login, password);
      applyAccount({
        login: result.login,
        username: result.account.username,
        money: result.account.money,
        data: result.account.data
      });
      closeModal();
      toast(`已登录：${state.username}`);
    } catch (error) {
      setModalMessage(describeError(error));
    } finally {
      $("vtxModalSubmit").disabled = false;
    }
  };

  const buyBoostWithPassword = async () => {
    const vtx = sdk();
    if (!vtx) {
      setModalMessage("VTX 服务未加载。");
      return;
    }

    const password = $("vtxLoginPassword").value || "";
    if (!password) {
      setModalMessage("请输入密码确认支付。");
      return;
    }

    $("vtxModalSubmit").disabled = true;
    setModalMessage("正在支付…", true);

    try {
      const result = await vtx.pay({
        amount: BOOST_PRICE,
        party: BOOST_PARTY,
        description: BOOST_DESC,
        password
      });

      state.money = String(result.account.money ?? state.money);
      state.data = result.account.data && typeof result.account.data === "object" ? result.account.data : state.data;
      const next = normalizeBoost(state.boost) + 1;
      state.boost = next;

      try {
        await persistBoost(next);
      } catch (error) {
        /* 写入失败不影响本局使用，下次刷新会以服务端为准 */
      }

      closeModal();
      render();
      toast(`购买成功，剩 ${BOOST_PRICE} VTX 已扣除（道具 ×${next}）`);
    } catch (error) {
      setModalMessage(describeError(error));
    } finally {
      $("vtxModalSubmit").disabled = false;
    }
  };

  const openLoginModal = () => {
    openModal({
      title: "登录 Vitual XRing",
      desc: "用 VTX 账户登录，同步余额与成绩。",
      mode: "login",
      submitLabel: "登录",
      onSubmit: doLogin
    });
  };

  const openBuyModal = () => {
    if (!state.loggedIn) {
      openLoginModal();
      return;
    }

    openModal({
      title: "购买全 PERFECT 道具",
      desc: `${BOOST_PRICE} VTX · 一个谱面内全部判定为 PERFECT / CERT PERFECT`,
      mode: "password",
      submitLabel: `支付 ${BOOST_PRICE} VTX`,
      onSubmit: buyBoostWithPassword
    });
  };

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
        else openLoginModal();
      });
    }

    if (nodes.buy) nodes.buy.addEventListener("click", openBuyModal);

    const close = $("vtxModalClose");
    if (close) close.addEventListener("click", closeModal);
    const cancel = $("vtxModalCancel");
    if (cancel) cancel.addEventListener("click", closeModal);

    const submit = $("vtxModalSubmit");
    if (submit) {
      submit.addEventListener("click", () => {
        if (modalSubmit) modalSubmit();
      });
    }

    const modal = $("vtxModal");
    if (modal) {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeModal();
      });
    }

    const password = $("vtxLoginPassword");
    if (password) {
      password.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && modalSubmit) {
          event.preventDefault();
          modalSubmit();
        }
      });
    }

    const name = $("vtxLoginName");
    if (name) {
      name.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (password) password.focus();
        }
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal && !modal.hidden) closeModal();
    });
  };

  const init = async () => {
    bind();
    render();

    const vtx = sdk();
    if (!vtx) {
      render();
      return;
    }

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
    openLogin: openLoginModal,
    buyBoost: openBuyModal,
    logout
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
