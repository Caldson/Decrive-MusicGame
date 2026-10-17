(() => {
  "use strict";

  const MAX_PACKAGE_SIZE = 100 * 1024 * 1024;
  const DB_NAME = "beat-shift-library";
  const DB_STORE = "packages";
  const OFFICIAL_CHART_BACKGROUND = "./offical-chart/Neon%20Afterglow/bg.png";
  const DEFAULT_JUDGEMENT_MODE = "1A";
  const JUDGEMENT_MODES = new Set(["1A","1B","2A","2B","3A","3B","4A","4B","4C","4D","4E","5A","5B","5C","5D","5E","5F"]);
  const KEYS = ["d", "f", "j", "k"];
  const COLORS = ["#70e6d0", "#a99aff", "#f58db1", "#ffdb83"];
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const toastRegion = $("#toastRegion");
  const officialChart = {
    id: "official-neon-afterglow",
    title: "Neon Afterglow",
    artist: "DECRIVE STUDIO",
    bpm: 128,
    meter: "4/4",
    difficulty: 5.9,
    offsetMs: 0,
    notes: [
      [700,0],[1170,1],[1640,2],[2110,3],[2580,0],[3050,1],[3520,2],[3990,3],
      [4460,0],[4695,2],[4930,1],[5400,3],[5870,2],[6340,0],[6810,1],[7280,3],
      [7750,0],[7985,1],[8220,2],[8690,3],[9160,2],[9630,1],[10100,0],[10570,3],
      [11040,0],[11275,2],[11510,1],[11980,3],[12450,2],[12920,0],[13390,1],[13860,3]
    ].map(([timeMs,lane]) => ({timeMs,lane}))
  };

  let playerCharts = [];
  let editorMedia = { music: null, background: null, musicName: "", backgroundName: "" };
  let currentGame = null;
  let gameFrame = 0;
  let gameAudio = null;
  let gameAudioUrl = null;
  let gameSynth = null;
  let gameBackgroundUrl = null;
  let pressedKeys = new Set();
  let activeChart = null;

  const notify = (message, type = "success") => {
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.textContent = message;
    toastRegion.append(item);
    window.setTimeout(() => item.remove(), 3400);
  };

  const openDatabase = () => new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("此浏览器不支持本地谱面存储。"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开谱面数据库。"));
  });

  const databaseAction = async (mode, action) => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(DB_STORE, mode);
      const request = action(transaction.objectStore(DB_STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("本地存储操作失败。"));
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => reject(transaction.error || new Error("本地存储操作失败。"));
    });
  };

  const readStored = async key => databaseAction("readonly", store => store.get(key));
  const writeStored = async (key, value) => databaseAction("readwrite", store => store.put(value, key));

  const saveChartFilesToDirectory = async (directory, chart, entries = null, media = null) => {
    const files = new Map();
    if (entries) {
      for (const entry of entries) {
        const name = entry.name.split("/").pop();
        if (!name || name.includes("..")) continue;
        files.set(name, entry.data);
      }
    }
    files.set("chart.json", encoder.encode(JSON.stringify(normalizeChart(chart), null, 2)));
    if (!files.has("bg.png")) {
      const background = media?.background ? await convertBackgroundToPng(media.background) : await createDefaultBackground();
      files.set("bg.png", new Uint8Array(await background.arrayBuffer()));
    }
    if (media?.music && ![...files.keys()].some(name => /^music\./i.test(name))) {
      files.set(`music.${extensionFor(media.musicName, media.music.type)}`, new Uint8Array(await media.music.arrayBuffer()));
    }
    const totalSize = [...files.values()].reduce((size, data) => size + (data.byteLength ?? data.size), 0);
    if (totalSize > MAX_PACKAGE_SIZE) throw new Error("谱面包素材总大小超过 100 MB 限制。");
    const folderName = `${cleanFilename(chart.title)}-${String(chart.id || Date.now()).slice(-6)}`;
    const chartDirectory = await directory.getDirectoryHandle(folderName, {create:true});
    for (const [name, data] of files) {
      const file = await chartDirectory.getFileHandle(name, {create:true});
      const writable = await file.createWritable();
      await writable.write(data instanceof Blob ? data : new Blob([data]));
      await writable.close();
    }
    return folderName;
  };

  const requestProjectDirectory = async () => {
    if (!("showDirectoryPicker" in window) || !window.isSecureContext) return null;
    let root = await readStored("project-root-handle").catch(() => null);
    if (root) {
      let permission = await root.queryPermission({mode:"readwrite"});
      if (permission !== "granted") permission = await root.requestPermission({mode:"readwrite"});
      if (permission === "granted") return root;
    }
    root = await window.showDirectoryPicker({id:"decrive-project-root",mode:"readwrite"});
    await writeStored("project-root-handle", root);
    return root;
  };

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      table[n] = value >>> 0;
    }
    return table;
  })();

  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  const write16 = (view, offset, value) => view.setUint16(offset, value, true);
  const write32 = (view, offset, value) => view.setUint32(offset, value >>> 0, true);

  const makeZip = files => {
    const payloadSize = files.reduce((total,file) => total + (file.data.byteLength ?? file.data.length),0);
    if (payloadSize > MAX_PACKAGE_SIZE) throw new Error("导出的谱面包素材总大小超过 100 MB。");
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length + data.length);
      const localView = new DataView(local.buffer);
      write32(localView, 0, 0x04034b50);
      write16(localView, 4, 20);
      write16(localView, 6, 0x0800);
      write16(localView, 8, 0);
      write16(localView, 10, 0);
      write16(localView, 12, 0);
      write32(localView, 14, crc);
      write32(localView, 18, data.length);
      write32(localView, 22, data.length);
      write16(localView, 26, name.length);
      write16(localView, 28, 0);
      local.set(name, 30);
      local.set(data, 30 + name.length);
      localParts.push(local);

      const central = new Uint8Array(46 + name.length);
      const centralView = new DataView(central.buffer);
      write32(centralView, 0, 0x02014b50);
      write16(centralView, 4, 20);
      write16(centralView, 6, 20);
      write16(centralView, 8, 0x0800);
      write16(centralView, 10, 0);
      write16(centralView, 12, 0);
      write16(centralView, 14, 0);
      write32(centralView, 16, crc);
      write32(centralView, 20, data.length);
      write32(centralView, 24, data.length);
      write16(centralView, 28, name.length);
      write16(centralView, 30, 0);
      write16(centralView, 32, 0);
      write16(centralView, 34, 0);
      write16(centralView, 36, 0);
      write32(centralView, 38, 0);
      write32(centralView, 42, localOffset);
      central.set(name, 46);
      centralParts.push(central);
      localOffset += local.length;
    }
    const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    write32(endView, 0, 0x06054b50);
    write16(endView, 4, 0);
    write16(endView, 6, 0);
    write16(endView, 8, files.length);
    write16(endView, 10, files.length);
    write32(endView, 12, centralSize);
    write32(endView, 16, localOffset);
    write16(endView, 20, 0);
    return new Blob([...localParts, ...centralParts, end], {type: "application/zip"});
  };

  const unzip = async file => {
    if (file.size > MAX_PACKAGE_SIZE) throw new Error("谱面包超过 100 MB 限制。");
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const minEnd = Math.max(0, bytes.length - 65557);
    let endOffset = -1;
    for (let i = bytes.length - 22; i >= minEnd; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { endOffset = i; break; }
    }
    if (endOffset < 0) throw new Error("无法读取 ZIP 文件尾记录，文件可能已损坏。");
    const count = view.getUint16(endOffset + 10, true);
    let cursor = view.getUint32(endOffset + 16, true);
    const files = new Map();
    let expandedSize = 0;
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP 目录结构无效。");
      const method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const expanded = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).replaceAll("\\", "/");
      cursor += 46 + nameLength + extraLength + commentLength;
      expandedSize += expanded;
      if (expandedSize > MAX_PACKAGE_SIZE) throw new Error("解压后的谱面包超过 100 MB 限制。");
      if (name.endsWith("/") || name.split("/").includes("..")) continue;
      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("ZIP 文件头无效。");
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
      let data;
      if (method === 0) data = compressed.slice();
      else if (method === 8 && "DecompressionStream" in window) {
        try {
          const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
          data = new Uint8Array(await new Response(stream).arrayBuffer());
        } catch (error) {
          throw new Error(`无法解压 ${name}：${error.message}`);
        }
      } else throw new Error(`不支持 ${name} 使用的 ZIP 压缩方式。`);
      if (data.byteLength !== expanded) throw new Error(`文件 ${name} 解压后长度不匹配。`);
      files.set(name.split("/").pop().toLowerCase(), data);
    }
    return files;
  };

  const cleanFilename = name => (name || "untitled").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().slice(0, 70) || "untitled";
  const normalizeChart = input => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("chart.json 必须是 JSON 对象。");
    const bpm = Number(input.bpm);
    const notesSource = input.notes;
    if (!Number.isFinite(bpm) || bpm < 40 || bpm > 300) throw new Error("BPM 必须为 40–300 之间的数字。");
    if (!Array.isArray(notesSource) || notesSource.length > 50000) throw new Error("notes 必须是最多包含 50000 个音符的数组。");
    const notes = notesSource.map((note, index) => {
      const timeMs = Number(note?.timeMs ?? note?.time);
      const lane = Number(note?.lane);
      if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > 3600000 || !Number.isInteger(lane) || lane < 0 || lane > 3) {
        throw new Error(`第 ${index + 1} 个音符格式无效。每个音符需包含非负 timeMs 和 0–3 的 lane。`);
      }
      return {timeMs, lane};
    }).sort((a, b) => a.timeMs - b.timeMs);
    const difficulty = Number(input.difficulty ?? 3.4);
    if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 15) throw new Error("难度等级必须在 0–15 之间。");
    return {
      id: String(input.id || `player-${Date.now().toString(36)}`),
      title: String(input.title || input.name || "Untitled track").slice(0, 60),
      artist: String(input.artist || "PLAYER ONE").slice(0, 60),
      bpm,
      meter: ["3/4","4/4","5/4","6/8","7/8"].includes(input.meter) ? input.meter : "4/4",
      difficulty,
      offsetMs: Math.max(-600, Math.min(600, Number(input.offsetMs) || 0)),
      notes
    };
  };

  const loadPackage = async file => {
    if (!file || file.size > MAX_PACKAGE_SIZE) throw new Error("谱面包最大限制为 100 MB。");
    const entries = await unzip(file);
    const chartBytes = entries.get("chart.json");
    const background = entries.get("bg.png");
    if (!chartBytes) throw new Error("谱面包缺少 chart.json。");
    if (!background) throw new Error("谱面包缺少 bg.png。");
    let chart;
    try { chart = normalizeChart(JSON.parse(decoder.decode(chartBytes))); }
    catch (error) { throw new Error(`chart.json 无效：${error.message}`); }
    const packageId = `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
    chart.id = packageId;
    const record = {
      id: packageId,
      title: chart.title,
      artist: chart.artist,
      bpm: chart.bpm,
      meter: chart.meter,
      difficulty: chart.difficulty,
      noteCount: chart.notes.length,
      chart,
      entries: [...entries.entries()].map(([name,data]) => ({name,data}))
    };
    await writeStored(packageId, record);
    playerCharts.unshift({...record, entries: undefined});
    savePlayerIndex();
    renderPlayers();
    return record;
  };

  const savePlayerIndex = () => {
    localStorage.setItem("beat-shift-player-charts", JSON.stringify(playerCharts.map(({id,title,artist,bpm,meter,difficulty,noteCount}) => ({id,title,artist,bpm,meter,difficulty,noteCount}))));
    $("#playerCount").textContent = String(playerCharts.length).padStart(2,"0");
    $("#playerCountLabel").textContent = `( ${String(playerCharts.length).padStart(2,"0")} )`;
  };

  const loadPlayers = async () => {
    try {
      const metadata = JSON.parse(localStorage.getItem("beat-shift-player-charts") || "[]");
      const loaded = [];
      for (const entry of metadata) {
        const record = await readStored(entry.id);
        if (record) loaded.push({...record, entries: undefined});
      }
      playerCharts = loaded;
    } catch (error) {
      notify(`读取本地谱面失败：${error.message}`, "error");
      playerCharts = [];
    }
    savePlayerIndex();
    renderPlayers();
  };

  const renderPlayers = () => {
    const list = $("#playerList");
    list.replaceChildren();
    $("#playerEmpty").hidden = playerCharts.length > 0;
    for (const chart of playerCharts) {
      const card = document.createElement("article");
      card.className = "player-card";
      const art = document.createElement("div");
      art.className = "player-card-art";
      art.textContent = "♫";
      const details = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = chart.title;
      const metadata = document.createElement("p");
      metadata.textContent = `${chart.artist} · ${chart.bpm} BPM · ${chart.noteCount} NOTES`;
      details.append(title, metadata);
      const difficulty = document.createElement("span");
      difficulty.className = "player-difficulty";
      difficulty.textContent = Number(chart.difficulty).toFixed(1);
      const actions = document.createElement("div");
      actions.className = "player-actions";
      const play = document.createElement("button");
      play.className = "small-play";
      play.textContent = "开始游玩";
      play.addEventListener("click", () => launchStoredChart(chart.id));
      const share = document.createElement("button");
      share.className = "small-play";
      share.textContent = "保存到 players-chart";
      share.addEventListener("click", () => writeChartToPlayersFolder(chart.id));
      actions.append(play, share);
      card.append(art, details, difficulty, actions);
      list.append(card);
    }
  };

  const openView = name => {
    const titles = {official:"官方谱面",players:"玩家谱面",editor:"制谱器",settings:"设置"};
    $$(".view").forEach(view => view.classList.toggle("active", view.id === `view-${name}`));
    $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === name));
    $("#crumbTitle").textContent = titles[name];
    if (name === "editor") drawTimeline();
    else if (typeof stopEditorPlayback === "function") stopEditorPlayback();
  };

  $$(".nav-item").forEach(button => button.addEventListener("click", () => openView(button.dataset.view)));
  $("#importChart").addEventListener("click", () => $("#chartFileInput").click());
  $("#emptyImport").addEventListener("click", () => $("#chartFileInput").click());
  $("#chartFileInput").addEventListener("change", async event => {
    const [file] = event.target.files;
    event.target.value = "";
    if (!file) return;
    try {
      const chart = await loadPackage(file);
      notify(`已导入「${chart.title}」，现在可以开始游玩。`);
    } catch (error) { notify(error.message, "error"); }
  });

  const buildChartPackage = async (chart, media = editorMedia) => {
    const clean = normalizeChart(chart);
    const background = media.background
      ? await convertBackgroundToPng(media.background)
      : await createDefaultBackground();
    const files = [
      {name:"chart.json",data:encoder.encode(JSON.stringify(clean, null, 2))},
      {name:"bg.png",data:new Uint8Array(await background.arrayBuffer())}
    ];
    if (media.music) files.push({name:`music.${extensionFor(media.musicName, media.music.type)}`,data:new Uint8Array(await media.music.arrayBuffer())});
    return makeZip(files);
  };

  const convertBackgroundToPng = async blob => {
    if (blob.type === "image/png") return blob;
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法转换背景图片，请换一张 PNG 图片后重试。");
      context.drawImage(image,0,0);
      return await new Promise((resolve,reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("背景图片转换失败。")),"image/png"));
    } catch (error) {
      throw new Error(`背景图片无法转换为 PNG：${error.message}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const createDefaultBackground = () => new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext("2d");
    if (!context) { reject(new Error("无法生成默认背景图，请添加一张背景图片后重试。")); return; }
    const gradient = context.createLinearGradient(0, 0, 1280, 720);
    gradient.addColorStop(0, "#16192a");
    gradient.addColorStop(.55, "#25223d");
    gradient.addColorStop(1, "#102421");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1280, 720);
    const glow = context.createRadialGradient(820, 280, 20, 820, 280, 450);
    glow.addColorStop(0, "#9d8bff55");
    glow.addColorStop(1, "#9d8bff00");
    context.fillStyle = glow;
    context.fillRect(0, 0, 1280, 720);
    context.strokeStyle = "#d8d9ff12";
    context.lineWidth = 1;
    for (let x = 0; x < 1280; x += 48) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 720); context.stroke();
    }
    for (let y = 0; y < 720; y += 48) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(1280, y); context.stroke();
    }
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("默认背景图生成失败。")), "image/png");
  });

  const extensionFor = (filename, mime = "") => {
    const suffix = String(filename || "").match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
    if (suffix) return suffix;
    return ({ "audio/mpeg":"mp3", "audio/wav":"wav", "audio/ogg":"ogg", "audio/mp4":"m4a" })[mime] || "audio";
  };

  const currentEditorChart = () => ({
    id: `custom-${Date.now().toString(36)}`,
    title: $("#chartTitle").value.trim() || "Untitled track",
    artist: $("#chartArtist").value.trim() || "PLAYER ONE",
    bpm: Number($("#chartBpm").value),
    meter: $("#chartMeter").value,
    difficulty: Number($("#chartDifficulty").value),
    offsetMs: Number($("#chartOffset").value) || 0,
    notes: editorNotes.map(note => ({...note}))
  });

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  $("#exportChart").addEventListener("click", async () => {
    try {
      const chart = currentEditorChart();
      const blob = await buildChartPackage(chart);
      downloadBlob(blob, `${cleanFilename(chart.title)}.zip`);
      notify("谱面包已导出：包含 chart.json、bg.png 和可选音乐。");
    } catch (error) { notify(error.message, "error"); }
  });

  const writeChartToPlayersFolder = async id => {
    try {
      let chart;
      let entries;
      let media = {music:null,background:null};
      if (id === "editor") chart = currentEditorChart();
      else {
        const record = await readStored(id);
        if (!record) throw new Error("找不到这份谱面，请重新导入。");
        chart = record.chart;
        entries = record.entries;
        const bg = entries.find(entry => entry.name.toLowerCase() === "bg.png")?.data;
        const audio = entries.find(entry => /^music\./i.test(entry.name));
        if (bg) media.background = new Blob([bg], {type:"image/png"});
        if (audio) {
          media.musicName = audio.name;
          media.music = new Blob([audio.data]);
        }
      }
      if (!("showDirectoryPicker" in window) || !window.isSecureContext) {
        const blob = entries
          ? makeZip(entries.map(entry => ({name:entry.name,data:entry.data})))
          : await buildChartPackage(chart, media);
        downloadBlob(blob, `${cleanFilename(chart.title)}.zip`);
        notify("浏览器不支持直接写入项目目录，已下载谱面包；请解压到 players-chart。");
        return;
      }
      notify("请选择 Decrive 项目根目录，谱面将写入其中的 players-chart 文件夹。");
      const root = await requestProjectDirectory();
      const playersDirectory = await root.getDirectoryHandle("players-chart", {create:true});
      const folderName = await saveChartFilesToDirectory(playersDirectory, chart, entries, media);
      notify(`谱面已保存到 players-chart/${folderName}/，提交项目后即可共享。`);
    } catch (error) {
      if (error.name !== "AbortError") notify(`上传失败：${error.message}`, "error");
    }
  };

  $("#uploadChart").addEventListener("click", () => writeChartToPlayersFolder("editor"));

  let editorNotes = [];
  let editorPlayhead = 0;
  let editorHistory = [];
  let editorFuture = [];
  const EDITOR_HISTORY_LIMIT = 60;

  const editorPlayback = {
    playing: false,
    raf: 0,
    audio: null,
    audioUrl: "",
    context: null,
    startedAt: 0,
    nextBeat: 0
  };

  const saveEditorDraft = () => {
    const draft = {
      title:$("#chartTitle").value, artist:$("#chartArtist").value,
      bpm:$("#chartBpm").value, meter:$("#chartMeter").value,
      difficulty:$("#chartDifficulty").value, offset:$("#chartOffset").value,
      notes:editorNotes
    };
    localStorage.setItem("beat-shift-editor-draft", JSON.stringify(draft));
  };
  const saveEditorMedia = () => writeStored("editor-media", editorMedia)
    .catch(error => notify(`草稿素材保存失败：${error.message}`, "error"));

  const editorBpm = () => Math.max(40, Math.min(300, Number($("#chartBpm").value) || 120));
  const editorBeatMs = () => 60000 / editorBpm();
  const editorBeatsPerBar = () => {
    const beats = Number(String($("#chartMeter").value || "4/4").split("/")[0]);
    return Number.isFinite(beats) && beats > 0 ? beats : 4;
  };
  const editorSnapDivision = () => Number($("#editorSnap").value) || 0;

  const snapEditorTime = (timeMs) => {
    const division = editorSnapDivision();
    const value = Math.max(0, timeMs);
    if (division <= 0) return Math.round(value);
    const step = editorBeatMs() / division;
    return Math.round(value / step) * step;
  };

  const editorSpanMs = () => {
    const autoSpan = Math.max(
      editorBeatMs() * editorBeatsPerBar() * 8,
      (editorNotes.at(-1)?.timeMs ?? 0) + editorBeatMs() * 4
    );
    const chosen = $("#editorZoom").value;
    const seconds = chosen === "auto" ? Math.ceil(autoSpan / 1000) : Number(chosen) || 30;
    return Math.max(4000, seconds * 1000);
  };

  const formatEditorTime = (ms) => {
    const total = Math.max(0, ms) / 1000;
    const minutes = Math.floor(total / 60);
    const seconds = total - minutes * 60;
    return `${String(minutes).padStart(2,"0")}:${seconds.toFixed(3).padStart(6,"0")}`;
  };

  const snapshotEditor = () => editorNotes.map(note => ({...note}));

  const syncEditorHistoryButtons = () => {
    $("#undoTap")?.classList.toggle("active", editorHistory.length > 0);
    $("#redoTap")?.classList.toggle("active", editorFuture.length > 0);
  };

  const pushEditorHistory = () => {
    editorHistory.push(snapshotEditor());
    if (editorHistory.length > EDITOR_HISTORY_LIMIT) editorHistory.shift();
    editorFuture = [];
    syncEditorHistoryButtons();
  };

  const applyEditorNotes = notes => {
    editorNotes = notes.map(note => ({lane:Number(note.lane), timeMs:Math.max(0, Math.round(note.timeMs))}));
    editorNotes.sort((a,b) => a.timeMs-b.timeMs || a.lane-b.lane);
    updateEditor();
  };

  const undoEditor = () => {
    if (!editorHistory.length) return;
    editorFuture.push(snapshotEditor());
    applyEditorNotes(editorHistory.pop());
  };

  const redoEditor = () => {
    if (!editorFuture.length) return;
    editorHistory.push(snapshotEditor());
    applyEditorNotes(editorFuture.pop());
  };

  const updatePlayheadNode = () => {
    const span = editorSpanMs();
    const ratio = Math.max(0, Math.min(100, editorPlayhead / span * 100));
    const node = $("#laneTrack .playhead");
    if (node) node.style.left = `${ratio}%`;
    const label = $("#editorTime");
    if (label) label.textContent = formatEditorTime(editorPlayhead);
  };

  const seekEditor = timeMs => {
    editorPlayhead = Math.max(0, Math.min(editorSpanMs(), timeMs));
    if (editorPlayback.audio) editorPlayback.audio.currentTime = editorPlayhead / 1000;
    if (editorPlayback.playing) editorPlayback.startedAt = performance.now() - editorPlayhead;
    updatePlayheadNode();
  };

  const stopEditorPlayback = () => {
    editorPlayback.playing = false;
    cancelAnimationFrame(editorPlayback.raf);
    editorPlayback.raf = 0;
    if (editorPlayback.audio) editorPlayback.audio.pause();
    $("#editorPlayIcon") && ($("#editorPlayIcon").textContent = "▶");
    $("#editorPlay")?.classList.remove("active");
  };

  const tickEditorPlayback = () => {
    if (!editorPlayback.playing) return;
    const span = editorSpanMs();
    editorPlayhead = editorPlayback.audio
      ? editorPlayback.audio.currentTime * 1000
      : performance.now() - editorPlayback.startedAt;

    if (!editorPlayback.audio && editorPlayback.context) {
      const beat = editorBeatMs();
      const beatsPerBar = editorBeatsPerBar();
      const ctx = editorPlayback.context;
      while (editorPlayback.nextBeat * beat <= editorPlayhead + 90) {
        const index = editorPlayback.nextBeat;
        const when = ctx.currentTime + Math.max(0, (index * beat - editorPlayhead) / 1000);
        beep(ctx, when, index % beatsPerBar === 0 ? 720 : 470, .05, .03);
        editorPlayback.nextBeat += 1;
      }
    }

    updatePlayheadNode();
    if (editorPlayhead >= span) {
      editorPlayhead = span;
      updatePlayheadNode();
      stopEditorPlayback();
      return;
    }
    editorPlayback.raf = requestAnimationFrame(tickEditorPlayback);
  };

  const toggleEditorPlayback = async () => {
    if (editorPlayback.playing) { stopEditorPlayback(); return; }
    if (editorPlayhead >= editorSpanMs() - 60) editorPlayhead = 0;

    if (editorMedia.music) {
      try {
        if (!editorPlayback.audioUrl) editorPlayback.audioUrl = URL.createObjectURL(editorMedia.music);
        if (!editorPlayback.audio) {
          editorPlayback.audio = new Audio(editorPlayback.audioUrl);
          editorPlayback.audio.preload = "auto";
          editorPlayback.audio.addEventListener("ended", () => stopEditorPlayback());
        }
        editorPlayback.audio.currentTime = editorPlayhead / 1000;
        await editorPlayback.audio.play();
      } catch (error) {
        notify("浏览器阻止了音乐播放，请再点一次播放。", "error");
        return;
      }
    } else {
      try {
        editorPlayback.context = editorPlayback.context || audioContext();
        await editorPlayback.context.resume();
      } catch (error) {
        notify(`节拍器不可用：${error.message}`, "error");
        return;
      }
    }

    editorPlayback.playing = true;
    editorPlayback.startedAt = performance.now() - editorPlayhead;
    editorPlayback.nextBeat = Math.ceil(editorPlayhead / editorBeatMs());
    const icon = $("#editorPlayIcon");
    if (icon) icon.textContent = "❚❚";
    $("#editorPlay")?.classList.add("active");
    tickEditorPlayback();
  };

  const attachNoteDrag = (marker, index) => {
    let dragging = false;
    let moved = false;

    const onMove = event => {
      if (!dragging) return;
      const track = $("#laneTrack");
      const bounds = track.getBoundingClientRect();
      const span = editorSpanMs();
      const timeMs = snapEditorTime((event.clientX - bounds.left) / bounds.width * span);
      const lane = Math.max(0, Math.min(3, Math.floor((event.clientY - bounds.top) / bounds.height * 4)));
      marker.dataset.pendingTime = String(timeMs);
      marker.dataset.pendingLane = String(lane);
      marker.style.left = `${Math.min(100, timeMs / span * 100)}%`;
      const rows = track.querySelectorAll(".lane-row");
      if (rows[lane]) rows[lane].append(marker);
      marker.classList.add("dragging");
      moved = true;
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      if (!dragging) return;
      dragging = false;
      marker.classList.remove("dragging");

      if (!moved) {
        pushEditorHistory();
        editorNotes.splice(index, 1);
        updateEditor();
        return;
      }

      const note = editorNotes[index];
      const timeMs = Number(marker.dataset.pendingTime ?? note.timeMs);
      const lane = Number(marker.dataset.pendingLane ?? note.lane);
      if (timeMs === note.timeMs && lane === note.lane) { updateEditor(); return; }
      pushEditorHistory();
      editorNotes[index] = {lane, timeMs};
      editorNotes.sort((a,b) => a.timeMs-b.timeMs || a.lane-b.lane);
      updateEditor();
    };

    marker.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const note = editorNotes[index];
      if (!note) return;
      dragging = true;
      moved = false;
      marker.dataset.pendingTime = String(note.timeMs);
      marker.dataset.pendingLane = String(note.lane);
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
    });
  };

  const drawTimeline = () => {
    const track = $("#laneTrack");
    const span = editorSpanMs();
    const beatPercent = editorBeatMs() / span * 100;
    const barPercent = beatPercent * editorBeatsPerBar();
    track.replaceChildren();
    track.style.background = [
      `repeating-linear-gradient(90deg, rgba(112,230,208,.16) 0, rgba(112,230,208,.16) 1px, transparent 1px, transparent ${barPercent}%)`,
      `repeating-linear-gradient(90deg, rgba(255,255,255,.06) 0, rgba(255,255,255,.06) 1px, transparent 1px, transparent ${beatPercent}%)`
    ].join(",");

    const ruler = $("#timelineRuler");
    ruler.replaceChildren();
    const barMs = editorBeatMs() * editorBeatsPerBar();
    const totalBars = Math.max(1, Math.ceil(span / barMs));
    const step = Math.max(1, Math.ceil(totalBars / 24));
    for (let bar = 0; bar <= totalBars; bar += step) {
      const mark = document.createElement("span");
      mark.style.left = `${Math.min(100, bar * barMs / span * 100)}%`;
      mark.textContent = String(bar + 1);
      ruler.append(mark);
    }

    for (let lane = 0; lane < 4; lane += 1) {
      const row = document.createElement("div");
      row.className = "lane-row";
      row.dataset.lane = String(lane);
      row.style.background = "none";
      track.append(row);
    }

    const rows = track.querySelectorAll(".lane-row");
    for (const [index, note] of editorNotes.entries()) {
      const marker = document.createElement("button");
      marker.type = "button";
      marker.className = `timeline-note lane-${note.lane}`;
      marker.style.left = `${Math.min(100, note.timeMs / span * 100)}%`;
      marker.title = `${KEYS[note.lane].toUpperCase()} · ${(note.timeMs/1000).toFixed(3)}s · 拖拽移动 / 单击删除`;
      marker.dataset.index = String(index);
      attachNoteDrag(marker, index);
      rows[note.lane].append(marker);
    }

    const playhead = document.createElement("div");
    playhead.className = "playhead";
    playhead.style.left = `${Math.min(100, editorPlayhead / span * 100)}%`;
    track.append(playhead);

    $("#tapCount").textContent = String(editorNotes.length);
  };

  const addEditorNote = (lane, timeMs, { keepHistory = true } = {}) => {
    if (editorNotes.length >= 50000) { notify("单张谱面最多添加 50000 个音符。", "error"); return; }
    if (keepHistory) pushEditorHistory();
    editorNotes.push({lane:Number(lane), timeMs:snapEditorTime(timeMs)});
    editorNotes.sort((a,b) => a.timeMs-b.timeMs || a.lane-b.lane);
    updateEditor();
  };

  const addEditorNoteAtCursor = lane => {
    if (editorPlayback.playing) { addEditorNote(lane, editorPlayhead); return; }
    const division = Math.max(1, editorSnapDivision());
    const step = editorBeatMs() / division;
    const last = editorNotes.at(-1)?.timeMs ?? -step;
    addEditorNote(lane, last + step);
  };

  const updateEditor = () => {
    const bpm = editorBpm();
    $("#previewTitle").textContent = $("#chartTitle").value || "Untitled track";
    $("#previewBpm").textContent = `${bpm} BPM · ${$("#chartMeter").value}`;
    $("#bpmOutput").value = bpm;
    $("#bpmNumber").value = bpm;
    $("#chartBpm").value = bpm;
    drawTimeline();
    updatePlayheadNode();
    const duration = $("#editorDuration");
    if (duration) duration.textContent = `${((editorNotes.at(-1)?.timeMs ?? 0)/1000).toFixed(1)}s`;
    const status = $("#editorStatusText");
    if (status) {
      status.textContent = editorNotes.length
        ? `草稿已自动保存 · ${editorNotes.length} 个音符`
        : "草稿已自动保存";
    }
    saveEditorDraft();
    syncEditorHistoryButtons();
  };

  $$(".preview-keys button").forEach(button => button.addEventListener("click", () => {
    addEditorNoteAtCursor(button.dataset.lane);
  }));

  $("#laneTrack").addEventListener("click", event => {
    if (event.target.closest(".timeline-note")) return;
    const row = event.target.closest(".lane-row");
    if (!row) return;
    const bounds = $("#laneTrack").getBoundingClientRect();
    addEditorNote(row.dataset.lane, (event.clientX - bounds.left) / bounds.width * editorSpanMs());
  });

  $("#timelineRuler").addEventListener("click", event => {
    const bounds = $("#laneTrack").getBoundingClientRect();
    seekEditor((event.clientX - bounds.left) / bounds.width * editorSpanMs());
  });

  $("#editorPlay").addEventListener("click", toggleEditorPlayback);
  $("#editorSnap").addEventListener("change", updateEditor);
  $("#editorZoom").addEventListener("change", updateEditor);
  $("#undoTap").addEventListener("click", undoEditor);
  $("#redoTap").addEventListener("click", redoEditor);
  $("#clearTaps").addEventListener("click", () => {
    if (!editorNotes.length) return;
    if (window.confirm("清空当前谱面的所有音符？")) {
      pushEditorHistory();
      editorNotes = [];
      updateEditor();
    }
  });
  ["chartTitle","chartArtist","chartDifficulty","chartOffset","chartMeter"].forEach(id => $(`#${id}`).addEventListener("input", updateEditor));
  $("#chartBpm").addEventListener("input", updateEditor);
  $("#bpmNumber").addEventListener("input", event => {
    const bpm = Math.max(40, Math.min(300, Number(event.target.value) || 120));
    $("#chartBpm").value = bpm;
    updateEditor();
  });

  $("#musicInput").addEventListener("change", async event => {
    const [file] = event.target.files;
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_PACKAGE_SIZE) { notify("音乐文件最大限制为 100 MB。", "error"); return; }
    editorMedia.music = file;
    editorMedia.musicName = file.name;
    $("#musicFileName").textContent = file.name;
    if (editorPlayback.audio) { editorPlayback.audio.pause(); editorPlayback.audio = null; }
    if (editorPlayback.audioUrl) { URL.revokeObjectURL(editorPlayback.audioUrl); editorPlayback.audioUrl = ""; }
    stopEditorPlayback();
    await saveEditorMedia();
    notify("音乐已添加到谱面草稿，点播放即可跟着音乐打点。");
  });
  $("#backgroundInput").addEventListener("change", async event => {
    const [file] = event.target.files;
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_PACKAGE_SIZE) { notify("背景图片最大限制为 100 MB。", "error"); return; }
    editorMedia.background = file;
    editorMedia.backgroundName = file.name;
    $("#backgroundFileName").textContent = file.name;
    const image = $("#backgroundPreview");
    if (image.dataset.url) URL.revokeObjectURL(image.dataset.url);
    image.dataset.url = URL.createObjectURL(file);
    image.src = image.dataset.url;
    image.hidden = false;
    $("#editorPreview").classList.add("has-background");
    await saveEditorMedia();
    notify("背景已添加到谱面草稿。");
  });

  const restoreEditor = async () => {
    try {
      const draft = JSON.parse(localStorage.getItem("beat-shift-editor-draft") || "null");
      if (draft) {
        $("#chartTitle").value = draft.title || "Untitled track";
        $("#chartArtist").value = draft.artist || "PLAYER ONE";
        $("#chartBpm").value = draft.bpm || 120;
        $("#bpmNumber").value = draft.bpm || 120;
        $("#chartMeter").value = draft.meter || "4/4";
        $("#chartDifficulty").value = draft.difficulty || 3.4;
        $("#chartOffset").value = draft.offset || 0;
        editorNotes = Array.isArray(draft.notes) ? draft.notes : [];
        editorNotes.sort((a,b) => a.timeMs-b.timeMs || a.lane-b.lane);
      }
      editorHistory = [];
      editorFuture = [];
      editorPlayhead = 0;
      const media = await readStored("editor-media");
      if (media) {
        editorMedia = media;
        if (media.music) $("#musicFileName").textContent = media.musicName || "音乐已添加";
        if (media.background) {
          $("#backgroundFileName").textContent = media.backgroundName || "背景已添加";
          const image = $("#backgroundPreview");
          image.dataset.url = URL.createObjectURL(media.background);
          image.src = image.dataset.url;
          image.hidden = false;
          $("#editorPreview").classList.add("has-background");
        }
      }
    } catch (error) { notify(`恢复制谱草稿失败：${error.message}`, "error"); }
    updateEditor();
  };

  const modeDescriptions = {
    "1A":"标准判定，合并早晚方向，并将 CERT PERFECT 计为 PERFECT。",
    "1B":"将 GREAT 与 GOOD 按击打方向合并显示为 EARLY 或 LATE。",
    "2A":"分别显示早/晚 GREAT 与 GOOD。",
    "2B":"分别显示早/晚 GREAT 与 GOOD，并区分 CERT PERFECT。",
    "3A":"合并早晚方向，但保留 CERT PERFECT。",
    "3B":"坏判定单独显示；其余非完美偏差按方向显示 EARLY 或 GREAT。",
    "4A":"所有 ±76–200 ms 偏差合并为 EARLY 或 LATE，不区分 BAD/GOOD/GREAT。",
    "4B":"显示 GOOD、GREAT、PERFECT；BAD 合并到 GOOD。",
    "4C":"与 4B 相同，并区分 CERT PERFECT。",
    "4D":"与 4A 相同，并区分 CERT PERFECT。",
    "4E":"只接受 PERFECT 与 CERT PERFECT，其余击打均判 MISS。",
    "5A":"测试模式：任何击打与漏击都显示 MISS。",
    "5B":"测试模式：仅 ±176–200 ms 的 BAD 有效，其余击打显示 MISS。",
    "5C":"测试模式：仅 ±75 ms 内的 PERFECT 有效。",
    "5D":"测试模式：仅 ±5 ms 内的 CERT PERFECT 有效。",
    "5E":"测试模式：仅提前 76–200 ms 显示 EARLY。",
    "5F":"测试模式：仅延后 76–200 ms 显示 LATE。"
  };
  const settings = {offsetMs:0, judgementMode:DEFAULT_JUDGEMENT_MODE};
  const saveSettings = () => localStorage.setItem("beat-shift-settings", JSON.stringify(settings));
  const updateJudgementModeDescription = () => {
    const mode = $("#judgementMode").value;
    $("#modeDescription").textContent = modeDescriptions[mode];
  };
  const readSettings = () => {
    try {
      const saved = JSON.parse(localStorage.getItem("beat-shift-settings") || "{}");
      settings.offsetMs = Math.max(-600,Math.min(600,Number(saved.offsetMs)||0));
      settings.judgementMode = JUDGEMENT_MODES.has(saved.judgementMode) ? saved.judgementMode : DEFAULT_JUDGEMENT_MODE;
    } catch { settings.offsetMs = 0; }
    $("#offsetSlider").value = settings.offsetMs;
    $("#offsetDisplay").textContent = settings.offsetMs > 0 ? `+${settings.offsetMs}` : String(settings.offsetMs);
    $("#judgementMode").value = settings.judgementMode;
    updateJudgementModeDescription();
  };
  $("#offsetSlider").addEventListener("input", event => {
    settings.offsetMs = Number(event.target.value);
    $("#offsetDisplay").textContent = settings.offsetMs > 0 ? `+${settings.offsetMs}` : String(settings.offsetMs);
    saveSettings();
  });
  $("#resetOffset").addEventListener("click", () => {
    settings.offsetMs = 0;
    $("#offsetSlider").value = 0;
    $("#offsetDisplay").textContent = "0";
    saveSettings();
  });
  $("#judgementMode").addEventListener("change", event => {
    settings.judgementMode = JUDGEMENT_MODES.has(event.target.value) ? event.target.value : DEFAULT_JUDGEMENT_MODE;
    saveSettings();
    updateJudgementModeDescription();
  });

  const audioContext = () => {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) throw new Error("当前浏览器不支持 Web Audio，无法播放校准音。");
    return new AudioCtor();
  };

  const beep = (context, atTime, frequency, duration = 0.1, volume = 0.08) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, atTime);
    gain.gain.exponentialRampToValueAtTime(0.001, atTime + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(atTime);
    oscillator.stop(atTime + duration);
  };

  $("#testSound").addEventListener("click", async () => {
    try {
      const context = audioContext();
      await context.resume();
      const beatSeconds = 60 / 120;
      const start = context.currentTime + 0.25;
      for (let beat = 0; beat < 4; beat += 1) {
        const scheduled = start + beat * beatSeconds + settings.offsetMs / 1000;
        if (scheduled > context.currentTime) beep(context, scheduled, beat === 0 ? 950 : 660, beat === 0 ? .12 : .08);
      }
      window.setTimeout(() => context.close(), 3300);
    } catch (error) { notify(error.message, "error"); }
  });

  const chartAudioFor = async chart => {
    if (chart.entries) {
      const entry = chart.entries.find(item => /^music\./i.test(item.name));
      return entry ? {blob:new Blob([entry.data]),name:entry.name} : null;
    }
    const record = await readStored(chart.id);
    const entry = record?.entries?.find(item => /^music\./i.test(item.name));
    return entry ? {blob:new Blob([entry.data]),name:entry.name} : null;
  };

  const launchStoredChart = async id => {
    try {
      const record = await readStored(id);
      if (!record) throw new Error("找不到谱面包，请重新导入。");
      await launchGame(record.chart, record);
    } catch (error) { notify(error.message, "error"); }
  };

  const launchGame = async (chart, packageRecord = null) => {
    activeChart = normalizeChart(chart);
    if (packageRecord) activeChart.id = packageRecord.id;
    $("#gameTitle").textContent = activeChart.title;
    $("#gameMeta").textContent = `${activeChart.bpm} BPM · ${Number(activeChart.difficulty).toFixed(1)}`;
    $("#gameArtBg").style.backgroundImage = "";
    if (gameBackgroundUrl) URL.revokeObjectURL(gameBackgroundUrl);
    gameBackgroundUrl = null;
    if (packageRecord) {
      const bg = packageRecord.entries?.find(entry => entry.name.toLowerCase() === "bg.png")?.data;
      if (bg) {
        gameBackgroundUrl = URL.createObjectURL(new Blob([bg], {type:"image/png"}));
        $("#gameArtBg").style.backgroundImage = `url("${gameBackgroundUrl}")`;
      }
    } else if (activeChart.id === officialChart.id) {
      $("#gameArtBg").style.backgroundImage = `url("${OFFICIAL_CHART_BACKGROUND}")`;
    }
    const overlay = $("#gameOverlay");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden","false");
    document.body.style.overflow = "hidden";
    await startGameRun();
  };

  const playNoteSound = (context, time) => {
    beep(context,time,72,.12,.11);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(196,time);
    oscillator.frequency.exponentialRampToValueAtTime(110,time+.15);
    gain.gain.setValueAtTime(.045,time);
    gain.gain.exponentialRampToValueAtTime(.001,time+.17);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(time); oscillator.stop(time+.18);
  };

  const startGameRun = async () => {
    cancelAnimationFrame(gameFrame);
    $("#resultCard").hidden = true;
    $("#gameScore").textContent = "0000000";
    $("#gameCombo").textContent = "0";
    $("#judgement").textContent = "READY?";
    $("#gameProgress").style.width = "0%";
    $("#fallingNotes").replaceChildren();
    if (gameAudio) { gameAudio.pause(); gameAudio.src = ""; gameAudio = null; }
    if (gameAudioUrl) { URL.revokeObjectURL(gameAudioUrl); gameAudioUrl = null; }
    if (gameSynth) { await gameSynth.close().catch(() => {}); gameSynth = null; }
    let audioData = null;
    try { audioData = await chartAudioFor(activeChart); }
    catch (error) { notify(`音乐素材无法读取：${error.message}`, "error"); }
    const audio = audioData ? new Audio(URL.createObjectURL(audioData.blob)) : null;
    gameAudioUrl = audio ? audio.src : null;
    gameAudio = audio;
    const startAt = performance.now() + 1800;
    const notes = activeChart.notes.map((note,index) => ({
      ...note,
      index,
      target:startAt+note.timeMs+activeChart.offsetMs+settings.offsetMs,
      hit:false,
      element:null
    }));
    const maxTime = notes.reduce((maximum,note) => Math.max(maximum,note.timeMs), 10000);
    const game = {notes, startAt, endAt:startAt+maxTime+2500, score:0, combo:0, maxCombo:0, total:notes.length, done:0, audioStarted:false, boost:boostActive(), chartId:activeChart.id, chartTitle:activeChart.title};
    currentGame = game;
    if (game.boost) notify("道具生效：本谱面全部判定 PERFECT / CERT PERFECT", "success");
    $("#fallingNotes").replaceChildren();
    $("#gameProgress").style.width = "0%";
    game.activeNotes = new Set();
    game.nextNoteIndex = 0;
    if (audio) {
      audio.preload = "auto";
      audio.addEventListener("error", () => notify("音乐无法播放，请检查文件格式。", "error"), {once:true});
    } else {
      try {
        gameSynth = audioContext();
        await gameSynth.resume();
      } catch (error) { notify(`背景节拍不可用：${error.message}`, "error"); }
    }
    const render = now => {
      if (!currentGame || currentGame !== game) return;
      const elapsed = now - game.startAt;
      if (audio && !game.audioStarted && now >= game.startAt) {
        game.audioStarted = true;
        audio.play().catch(() => notify("浏览器阻止了音乐播放，请重新开始谱面。","error"));
      }
      if (gameSynth && !game.nextBeat) game.nextBeat = gameSynth.currentTime + Math.max(0,(game.startAt-now)/1000);
      if (gameSynth && now >= game.startAt) {
        const beatSeconds = 60 / activeChart.bpm;
        while (game.nextBeat < gameSynth.currentTime + 0.09) {
          const beatNumber = game.synthBeat || 0;
          if (beatNumber % 2 === 0) playNoteSound(gameSynth,game.nextBeat);
          else beep(gameSynth,game.nextBeat,beatNumber % 4 === 3 ? 450 : 340,.035,.018);
          game.nextBeat += beatSeconds;
          game.synthBeat = beatNumber + 1;
        }
      }
      const travelMs = 1650;
      while (game.nextNoteIndex < notes.length && notes[game.nextNoteIndex].target-now <= travelMs) {
        const note = notes[game.nextNoteIndex++];
        const element = document.createElement("div");
        element.className = "game-note";
        element.style.setProperty("--note-color",COLORS[note.lane]);
        element.style.left = `${(note.lane+.5)*25}%`;
        element.dataset.index = String(note.index);
        note.element = element;
        game.activeNotes.add(note);
        $("#fallingNotes").append(element);
      }
      for (const note of game.activeNotes) {
        const distance = note.target - now;
        if (game.boost && distance <= 0) {
          registerHit(note, 0);
          continue;
        }
        const position = Math.max(-15,Math.min(100,100-(distance/travelMs)*100));
        note.element.style.top = `${position}%`;
        if (distance < -200) {
          note.hit = true;
          note.done = true;
          game.done += 1;
          game.combo = 0;
          $("#gameCombo").textContent = "0";
          showJudgement("MISS");
          note.element.remove();
          game.activeNotes.delete(note);
        }
      }
      $("#gameProgress").style.width = `${Math.max(0,Math.min(100,elapsed/(maxTime+2500)*100))}%`;
      if (now >= game.endAt) { finishGame(game); return; }
      gameFrame = requestAnimationFrame(render);
    };
    gameFrame = requestAnimationFrame(render);
  };

  const showJudgement = label => {
    const node = $("#judgement");
    node.textContent = label;
    node.classList.remove("pop");
    void node.offsetWidth;
    node.classList.add("pop");
  };

  const classifyJudgement = delta => {
    const error = Math.abs(delta);
    if (error <= 5) return "CERT PERFECT";
    if (error <= 75) return "PERFECT";
    if (error <= 165) return "GREAT";
    if (error <= 175) return "GOOD";
    if (error <= 200) return "BAD";
    return "MISS";
  };

  const resolveJudgement = (delta, mode) => {
    const raw = classifyJudgement(delta);
    const early = delta > 0;
    const direction = early ? "EARLY" : "LATE";
    let label = raw;
    if (mode === "1A" && raw === "CERT PERFECT") label = "PERFECT";
    else if (mode === "1B" && (raw === "GREAT" || raw === "GOOD")) label = direction;
    else if ((mode === "2A" || mode === "2B") && (raw === "GREAT" || raw === "GOOD")) label = `${direction}${raw}`;
    else if (mode === "2A" && raw === "CERT PERFECT") label = "PERFECT";
    else if (mode === "3A") label = raw === "CERT PERFECT" ? "CERT PERFECT" : raw;
    else if (mode === "3B" && (raw === "GREAT" || raw === "GOOD")) label = early ? "EARLY" : "GREAT";
    else if ((mode === "4A" || mode === "4D") && raw !== "PERFECT" && raw !== "CERT PERFECT" && raw !== "MISS") label = direction;
    else if ((mode === "4B" || mode === "4C") && (raw === "BAD" || raw === "GOOD")) label = "GOOD";
    else if (mode === "4B" && raw === "CERT PERFECT") label = "PERFECT";
    else if (mode === "4E" && raw !== "PERFECT" && raw !== "CERT PERFECT") label = "MISS";
    else if (mode === "5A") label = "MISS";
    else if (mode === "5B" && raw !== "BAD") label = "MISS";
    else if (mode === "5C" && raw !== "PERFECT" && raw !== "CERT PERFECT") label = "MISS";
    else if (mode === "5C" && raw === "CERT PERFECT") label = "PERFECT";
    else if (mode === "5D" && raw !== "CERT PERFECT") label = "MISS";
    else if (mode === "5E") label = early && errorInTimingWindow(delta) ? "EARLY" : "MISS";
    else if (mode === "5F") label = !early && errorInTimingWindow(delta) ? "LATE" : "MISS";
    const points = {
      "CERT PERFECT":1000, "PERFECT":900, "GREAT":700, "EARLYGREAT":700, "LATEGREAT":700,
      "GOOD":400, "EARLYGOOD":400, "LATEGOOD":400, "EARLY":500, "LATE":500, "BAD":100
    }[label] || 0;
    return {label, points};
  };

  const errorInTimingWindow = delta => Math.abs(delta) > 75 && Math.abs(delta) <= 200;

  const boostActive = () => Boolean(window.DecriveAccount && window.DecriveAccount.isBoostActive());

  const registerHit = (note, delta) => {
    if (!currentGame) return;
    note.hit = true;
    if (note.element) {
      note.element.classList.add("note-hit");
      note.element.remove();
    }
    currentGame.activeNotes.delete(note);
    const timing = resolveJudgement(delta, settings.judgementMode);
    const label = timing.label;
    if (label === "MISS") currentGame.combo = 0;
    else {
      currentGame.score += timing.points + Math.min(100,currentGame.combo*2);
      currentGame.combo += 1;
    }
    currentGame.done += 1;
    currentGame.maxCombo = Math.max(currentGame.maxCombo,currentGame.combo);
    $("#gameScore").textContent = String(currentGame.score).padStart(7,"0");
    $("#gameCombo").textContent = String(currentGame.combo);
    showJudgement(label);
    if (gameSynth && label !== "MISS") beep(gameSynth,gameSynth.currentTime, label.includes("PERFECT") ? 900 : 680,.07,.045);
  };

  const hitLane = lane => {
    if (!currentGame) return;
    const now = performance.now();
    let closest = null;
    let distance = Infinity;
    for (const note of currentGame.activeNotes) {
      if (note.lane !== lane) continue;
      const delta = Math.abs(note.target-now);
      if (delta < distance) { distance = delta; closest = note; }
    }
    const laneNode = $(`.lane-${lane}`, $("#gameStage"));
    laneNode.classList.add("pressed");
    window.setTimeout(() => laneNode.classList.remove("pressed"),90);
    $("#hitFlash").classList.add("active");
    window.setTimeout(() => $("#hitFlash").classList.remove("active"),75);
    if (!closest || distance > 200) { showJudgement("空击"); return; }
    registerHit(closest, closest.target-now);
  };

  $("#gameStage .playfield").addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const lane = Math.max(0,Math.min(3,Math.floor((event.clientX-bounds.left)/bounds.width*4)));
    hitLane(lane);
  });

  const finishGame = game => {
    cancelAnimationFrame(gameFrame);
    currentGame = null;
    if (gameAudio) { gameAudio.pause(); gameAudio.currentTime = 0; gameAudio = null; }
    if (gameAudioUrl) { URL.revokeObjectURL(gameAudioUrl); gameAudioUrl = null; }
    if (gameSynth) { gameSynth.close().catch(() => {}); gameSynth = null; }
    const accuracy = game.total ? game.score/(game.total*1100) : 0;
    $("#resultGrade").textContent = accuracy >= .92 ? "S" : accuracy >= .8 ? "A" : accuracy >= .6 ? "B" : "C";
    $("#resultSummary").textContent = `${String(game.score).padStart(7,"0")} 分 · ${game.maxCombo} 最大连击`;
    $("#resultCard").hidden = false;
    if (window.DecriveAccount) {
      if (game.boost) window.DecriveAccount.consumeBoost();
      window.DecriveAccount.submitScore({
        chartId: game.chartId,
        chartTitle: game.chartTitle,
        score: game.score,
        combo: game.maxCombo,
        grade: $("#resultGrade").textContent,
        accuracy,
        boost: Boolean(game.boost),
        time: new Date().toISOString()
      });
    }
  };

  const closeGame = async () => {
    cancelAnimationFrame(gameFrame);
    currentGame = null;
    if (gameAudio) { gameAudio.pause(); gameAudio.src = ""; gameAudio = null; }
    if (gameAudioUrl) { URL.revokeObjectURL(gameAudioUrl); gameAudioUrl = null; }
    if (gameSynth) { await gameSynth.close().catch(() => {}); gameSynth = null; }
    if (gameBackgroundUrl) { URL.revokeObjectURL(gameBackgroundUrl); gameBackgroundUrl = null; }
    $("#gameOverlay").classList.remove("open");
    $("#gameOverlay").setAttribute("aria-hidden","true");
    document.body.style.overflow = "";
    pressedKeys.clear();
  };

  $("#playOfficial").addEventListener("click", () => launchGame(officialChart));
  $("#closeGame").addEventListener("click", closeGame);
  $("#retryGame").addEventListener("click", startGameRun);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && $("#gameOverlay").classList.contains("open")) { closeGame(); return; }
    const key = event.key.toLowerCase();
    const inEditor = $("#view-editor").classList.contains("active");
    if (inEditor && !event.target.matches("input,textarea,select")) {
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redoEditor();
        else undoEditor();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        redoEditor();
        return;
      }
      if (event.code === "Space" && !event.repeat) {
        event.preventDefault();
        toggleEditorPlayback();
        return;
      }
    }
    const lane = KEYS.indexOf(key);
    if (lane < 0 || event.repeat || event.target.matches("input,textarea,select")) return;
    if ($("#gameOverlay").classList.contains("open")) {
      event.preventDefault();
      hitLane(lane);
      pressedKeys.add(key);
    } else if (inEditor) {
      addEditorNoteAtCursor(lane);
    }
  });
  document.addEventListener("keyup", event => pressedKeys.delete(event.key.toLowerCase()));

  const init = async () => {
    readSettings();
    await Promise.all([loadPlayers(),restoreEditor()]);
  };
  init();
})();
