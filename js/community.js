/*
 * Decrive 社区曲库
 * - 读取 players-chart/index.json（与站点同源，无需 CORS）
 * - 上传谱面到 GitHub 仓库（token 用 secure.json 里的 AES-GCM 密文，见 js/decrive-crypto.js）
 * - 依赖 js/app.js 暴露的 window.DecriveLibrary
 */
(() => {
  "use strict";

  const REPO = "Caldson/Decrive-MusicGame";
  const BRANCH = "main";
  const DIR = "players-chart";
  const INDEX_PATH = `${DIR}/index.json`;
  const SECURE_PATH = "./secure.json";
  const MAX_FILE_BYTES = 8 * 1024 * 1024;

  const $ = (selector, root = document) => root.querySelector(selector);

  const state = {
    charts: [],
    loading: false,
    busy: false,
    token: null,
    secure: null,
    loaded: false
  };

  let nodes = {};

  /* ---------- 工具 ---------- */

  const notify = (message, type = "success") => {
    if (window.DecriveLibrary && typeof window.DecriveLibrary.notify === "function") {
      window.DecriveLibrary.notify(message, type);
      return;
    }
    const region = $("#toastRegion");
    if (!region) return;
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.textContent = message;
    region.append(item);
    window.setTimeout(() => item.remove(), 3400);
  };

  const toBase64 = bytes => {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  };

  const fromBase64 = text => {
    const binary = atob(String(text).replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };

  const slug = (text) =>
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "chart";

  const formatDate = value => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  };

  const currentAuthor = () => {
    const account = window.DecriveAccount && window.DecriveAccount.getState();
    if (account && account.loggedIn && account.username) return account.username;
    return "匿名玩家";
  };

  /* ---------- GitHub ---------- */

  const httpError = (status, action) => {
    let message;
    if (status === 401) message = `${action}失败：GitHub token 无效或已过期。`;
    else if (status === 403) message = `${action}失败：token 没有该仓库的 Contents 写权限（或已被限流）。请更新 secure.json。`;
    else if (status === 404) message = `${action}失败：找不到仓库或路径。`;
    else if (status === 409 || status === 422) message = `${action}失败：写入冲突，请重试。`;
    else if (status === 413) message = `${action}失败：文件过大。`;
    else message = `${action}失败（HTTP ${status}）。`;
    const error = new Error(message);
    error.status = status;
    return error;
  };

  const encodeRepoPath = path => String(path).split("/").map(encodeURIComponent).join("/");

  const loadToken = async () => {
    if (state.token) return state.token;

    let config;
    try {
      const response = await fetch(`${SECURE_PATH}?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      config = await response.json();
    } catch (error) {
      throw new Error("读取 secure.json 失败，社区上传暂不可用。");
    }

    if (!window.SecureBox) throw new Error("加密模块未加载，社区上传暂不可用。");

    const token = await window.SecureBox.decrypt(config);
    if (!token) throw new Error("secure.json 中没有可用的 token。");
    state.token = token;
    state.secure = config;
    return token;
  };

  const api = async (path, options = {}) => {
    const token = await loadToken();
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "decrive-community",
        "x-github-api-version": "2022-11-28",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });

    if (!response.ok) throw httpError(response.status, options.action || "操作");
    return response.status === 204 ? null : response.json();
  };

  const readRepoJson = async path => {
    try {
      const file = await api(`/repos/${REPO}/contents/${encodeRepoPath(path)}?ref=${BRANCH}`, { action: "读取" });
      return { data: JSON.parse(new TextDecoder().decode(fromBase64(file.content))), sha: file.sha };
    } catch (error) {
      if (error.status === 404) return { data: null, sha: null };
      throw error;
    }
  };

  const writeRepoFile = async (path, base64, message, sha) => {
    const body = { message, content: base64, branch: BRANCH };
    if (sha) body.sha = sha;
    return api(`/repos/${REPO}/contents/${encodeRepoPath(path)}`, {
      method: "PUT",
      body: JSON.stringify(body),
      action: "写入"
    });
  };

  /* ---------- 曲库读取 ---------- */

  const fetchIndex = async () => {
    const response = await fetch(`${DIR}/index.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`读取社区曲库失败（HTTP ${response.status}）`);
    const data = await response.json();
    const charts = Array.isArray(data && data.charts) ? data.charts : [];
    return charts.filter(item => item && item.folder);
  };

  const render = () => {
    if (!nodes.list) return;

    const charts = state.charts;
    nodes.list.replaceChildren();
    nodes.countLabel.textContent = `( ${String(charts.length).padStart(2, "0")} )`;

    if (nodes.empty) nodes.empty.hidden = charts.length > 0;

    for (const item of charts) {
      const card = document.createElement("article");
      card.className = "player-card community-card";

      const art = document.createElement("div");
      art.className = "player-art";
      art.textContent = "◍";

      const details = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = item.title || "Untitled track";
      const meta = document.createElement("p");
      meta.textContent = `${item.author || "匿名玩家"} · ${item.bpm || "?"} BPM · ${item.noteCount || 0} NOTES`;
      const badge = document.createElement("span");
      badge.className = "community-meta";
      badge.textContent = `${item.meter || "4/4"} · ${formatDate(item.createdAt)}${item.music ? " · 含音乐" : ""}`;
      details.append(title, meta, badge);

      const difficulty = document.createElement("span");
      difficulty.className = "player-difficulty";
      difficulty.textContent = Number(item.difficulty || 0).toFixed(1);

      const actions = document.createElement("div");
      actions.className = "player-actions";
      const button = document.createElement("button");
      button.className = "small-play";
      const installed = window.DecriveLibrary && window.DecriveLibrary.hasSource(item.id);
      button.textContent = installed ? "已在曲库" : "下载游玩";
      button.disabled = Boolean(installed) || state.busy;
      button.addEventListener("click", () => downloadChart(item, button));
      actions.append(button);

      card.append(art, details, difficulty, actions);
      nodes.list.append(card);
    }
  };

  const refresh = async ({ silent = false } = {}) => {
    if (state.loading) return;
    state.loading = true;
    if (nodes.status) nodes.status.textContent = "正在同步社区曲库…";
    try {
      state.charts = await fetchIndex();
      state.loaded = true;
      render();
      if (nodes.status) nodes.status.textContent = state.charts.length ? `已同步 ${state.charts.length} 份社区谱面` : "社区还没有谱面，来传第一份吧";
    } catch (error) {
      if (nodes.status) nodes.status.textContent = error.message;
      if (!silent) notify(error.message, "error");
    } finally {
      state.loading = false;
    }
  };

  /* ---------- 下载安装 ---------- */

  const fetchChartFile = async (folder, name) => {
    const response = await fetch(`${DIR}/${encodeURIComponent(folder)}/${encodeURIComponent(name)}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`${name} 下载失败（HTTP ${response.status}）`);
    return new Uint8Array(await response.arrayBuffer());
  };

  const downloadChart = async (item, button) => {
    if (!window.DecriveLibrary) { notify("谱面库尚未就绪，请刷新页面。", "error"); return; }
    if (state.busy) return;
    state.busy = true;
    const label = button ? button.textContent : "";
    if (button) { button.disabled = true; button.textContent = "下载中…"; }

    let installed = false;
    try {
      const entries = [];
      const chartBytes = await fetchChartFile(item.folder, "chart.json");
      entries.push({ name: "chart.json", data: chartBytes });

      let background = null;
      try { background = await fetchChartFile(item.folder, "bg.png"); } catch (error) { background = null; }
      if (background) entries.push({ name: "bg.png", data: background });

      const musicName = item.music || "";
      if (musicName) {
        const music = await fetchChartFile(item.folder, musicName);
        entries.push({ name: musicName, data: music });
      }

      const chart = JSON.parse(new TextDecoder().decode(chartBytes));
      await window.DecriveLibrary.install({
        chart,
        entries,
        sourceId: item.id,
        author: item.author
      });

      installed = true;
      notify(`已下载《${item.title}》，可在玩家谱面里游玩。`);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      state.busy = false;
      if (!installed && button) { button.disabled = false; button.textContent = label; }
    }

    render();
  };

  /* ---------- 上传 ---------- */

  const uniqueFolder = (index, title, id) => {
    const base = `${slug(title).slice(0, 40)}-${id.slice(-6)}`;
    const used = new Set(index.charts.map(item => item.folder));
    let folder = base;
    let attempt = 2;
    while (used.has(folder)) {
      folder = `${base}-${attempt}`;
      attempt += 1;
    }
    return folder;
  };

  const uploadPackage = async ({ chart, entries }) => {
    const index = await readRepoJson(INDEX_PATH);
    const current = index.data && Array.isArray(index.data.charts) ? index.data : { version: 1, charts: [] };

    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const folder = uniqueFolder(current, chart.title, id);
    const message = `社区谱面：${chart.title}（${currentAuthor()}）`;

    let musicName = null;
    let totalSize = 0;

    for (const entry of entries) {
      const name = String(entry.name).split("/").pop();
      if (!name || name.includes("..")) continue;
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      totalSize += data.byteLength;
      if (data.byteLength > MAX_FILE_BYTES) {
        throw new Error(`${name} 有 ${(data.byteLength / 1048576).toFixed(1)} MB，单个文件上限 8 MB。`);
      }
      if (/^music\./i.test(name)) musicName = name;
      await writeRepoFile(`${DIR}/${folder}/${name}`, toBase64(data), message);
    }

    const record = {
      id,
      folder,
      title: chart.title,
      artist: chart.artist,
      bpm: chart.bpm,
      meter: chart.meter,
      difficulty: chart.difficulty,
      noteCount: Array.isArray(chart.notes) ? chart.notes.length : 0,
      author: currentAuthor(),
      music: musicName,
      createdAt: new Date().toISOString(),
      size: totalSize
    };

    current.charts = [record, ...current.charts];
    current.version = current.version || 1;
    current.updatedAt = new Date().toISOString();

    const base64 = toBase64(new TextEncoder().encode(`${JSON.stringify(current, null, 4)}\n`));
    await writeRepoFile(INDEX_PATH, base64, `社区曲库：新增《${chart.title}》`, index.sha);

    return record;
  };

  const uploadFromEditor = async () => {
    if (state.busy) return;
    if (!window.DecriveLibrary) { notify("谱面库尚未就绪，请刷新页面。", "error"); return; }
    state.busy = true;
    notify("正在打包并上传到社区曲库…");
    let record = null;
    try {
      const pkg = await window.DecriveLibrary.packageFromEditor();
      record = await uploadPackage(pkg);
      notify(`《${record.title}》已上传，其他人刷新页面即可看到。`);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      state.busy = false;
    }
    if (record) await refresh({ silent: true });
  };

  const uploadStoredChart = async id => {
    if (state.busy) return;
    if (!window.DecriveLibrary) { notify("谱面库尚未就绪，请刷新页面。", "error"); return; }
    state.busy = true;
    notify("正在上传到社区曲库…");
    let record = null;
    try {
      const pkg = await window.DecriveLibrary.packageFromStored(id);
      record = await uploadPackage(pkg);
      notify(`《${record.title}》已上传到社区曲库。`);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      state.busy = false;
    }
    if (record) await refresh({ silent: true });
  };

  /* ---------- 初始化 ---------- */

  const init = () => {
    nodes = {
      list: $("#communityList"),
      empty: $("#communityEmpty"),
      countLabel: $("#communityCountLabel"),
      status: $("#communityStatus"),
      refresh: $("#refreshCommunity")
    };

    if (nodes.refresh) nodes.refresh.addEventListener("click", () => refresh());
    if (nodes.list) refresh({ silent: true });

    // 进入玩家谱面页时若还没加载过，再同步一次
    document.querySelectorAll(".nav-item").forEach(button => {
      if (button.dataset.view !== "players") return;
      button.addEventListener("click", () => {
        if (!state.loaded) refresh({ silent: true });
        else render();
      });
    });
  };

  window.DecriveCommunity = { refresh, uploadFromEditor, uploadStoredChart, uploadPackage };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
