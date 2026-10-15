#!/usr/bin/env node
/* ============================================================
 * server.js — 家庭旅行网站 · 云同步后端（Node 18+）
 *
 * 功能：
 *   1. 静态托管整个网站（index.html / css / js）
 *   2. 账号注册 / 登录（密码加盐哈希 + token 会话）
 *   3. 数据同步：records / routes / families 按登录用户的家庭过滤下发
 *      （非家庭成员在服务器端就拿不到你家数据，隐私安全）
 *   4. 照片 / 视频 / Live图 二进制存储
 *   5. 首次运行自动播种示例数据（system 记录 + 路线 + 封面图）
 *
 * 存储（自动二选一）：
 *   · 设置了环境变量 DATABASE_URL → 云端 Postgres（Neon/Supabase 等）
 *     —— 适配免费托管平台（Render 等），磁盘重置数据也不丢
 *   · 未设置 → 本地 cloud-data/ 目录（db.json + assets/）
 *
 * 启动：  node server.js     （默认端口 8390，环境变量 PORT 可覆盖）
 * ============================================================ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "cloud-data");
const ASSET_DIR = path.join(DATA_DIR, "assets");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PORT = process.env.PORT || 8390;
const HOST = process.env.HOST || "0.0.0.0";

/* ---------------- 云端 Postgres 连接（可选） ---------------- */
let pgPool = null;
let pgError = null;               // 最近一次数据库错误（/api/ping 会带上，方便排查）
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require("pg");
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      /* 关键：单条语句 15 秒超时 + 10 秒连接超时，避免数据库卡住时整个服务假死（503） */
      connectionTimeoutMillis: 10000,
      options: "-c statement_timeout=15000"
    });
    /* 必须监听，否则 pg 池的异步 error 会成为未捕获异常直接杀掉进程 */
    pgPool.on("error", (e) => { console.error("pg pool error:", e && e.message); });
    console.log("🐘 已启用云端 Postgres 存储（DATABASE_URL）");
  } catch (e) {
    console.error("pg 模块不可用，回退到本地文件模式:", e.message);
    pgPool = null;
  }
}
/* 兜底：任何未捕获的 Promise 异常都只记录，绝不退出进程（退出会导致平台一直 503） */
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e && e.message ? e.message : e));

/* ---------------- 数据库（内存 + 持久化） ---------------- */
let db = {
  users: {},      // { username: { salt, hash, familyId, createdAt } }
  families: {},   // { famId: { name, code, members: [], createdAt } }
  records: [],    // 旅行记录
  routes: [],     // 地图路线
  tokens: {},     // { token: username }
  assetsMeta: {}  // { assetId: { type, size, at } }
};
let saveTimer = null;
async function initStore() {
  if (pgPool) {
    /* 每一步都单独容错：数据库满/被锁/超时都只降级，绝不让启动失败（否则平台健康检查不过 → 永久 503） */
    try { await pgPool.query(`CREATE TABLE IF NOT EXISTS app_state (k text PRIMARY KEY, data jsonb)`); }
    catch (e) { console.error("建表 app_state 失败:", e.message); pgError = e.message; }
    try { await pgPool.query(`CREATE TABLE IF NOT EXISTS ft_assets (id text PRIMARY KEY, type text, data bytea)`); }
    catch (e) { console.error("建表 ft_assets 失败:", e.message); pgError = e.message; }
    try {
      const r = await pgPool.query(`SELECT data FROM app_state WHERE k = 'main'`);
      if (r.rows[0]) db = Object.assign(db, r.rows[0].data);
    } catch (e) { console.error("读取云端数据失败:", e.message); pgError = e.message; }
  } else {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
      db = Object.assign(db, raw);
    } catch { /* 首次运行 */ }
  }
  db.assetsMeta = db.assetsMeta || {};
  try { await seedIfEmpty(); } catch (e) { console.error("播种示例数据失败（可忽略）:", e.message); }
}
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistDb, 300);
}
async function persistDb() {
  try {
    if (pgPool) {
      await pgPool.query(
        `INSERT INTO app_state (k, data) VALUES ('main', $1) ON CONFLICT (k) DO UPDATE SET data = $1`,
        [JSON.stringify(db)]
      );
    } else {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
    }
  } catch (e) { console.error("db 保存失败:", e.message); }
}

/* ---------------- 资产存取（照片/视频/Live图） ---------------- */
async function putAsset(id, buf, type) {
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO ft_assets (id, type, data) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET type = $2, data = $3`,
      [id, type || "application/octet-stream", buf]
    );
  } else {
    fs.mkdirSync(ASSET_DIR, { recursive: true });
    fs.writeFileSync(path.join(ASSET_DIR, id), buf);
  }
  db.assetsMeta[id] = { type: type || "application/octet-stream", size: buf.length, at: Date.now() };
}
async function getAssetBuf(id) {
  if (pgPool) {
    const r = await pgPool.query(`SELECT type, data FROM ft_assets WHERE id = $1`, [id]);
    if (!r.rows[0]) return null;
    return { buf: r.rows[0].data, type: r.rows[0].type };
  }
  const file = path.join(ASSET_DIR, id);
  if (!fs.existsSync(file)) return null;
  return { buf: fs.readFileSync(file), type: db.assetsMeta[id]?.type };
}
async function delAsset(id) {
  if (pgPool) {
    await pgPool.query(`DELETE FROM ft_assets WHERE id = $1`, [id]).catch(() => {});
  } else {
    try { fs.unlinkSync(path.join(ASSET_DIR, id)); } catch {}
  }
  delete db.assetsMeta[id];
}

/* ---------------- 工具 ---------------- */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randToken = () => crypto.randomBytes(24).toString("hex");
const ok = (obj) => JSON.stringify(Object.assign({ ok: true }, obj));
const bad = (msg, code) => JSON.stringify({ ok: false, error: msg, code });
function usersPublic() {
  const out = {};
  for (const [name, u] of Object.entries(db.users))
    out[name] = { familyId: u.familyId || null, createdAt: u.createdAt };
  return out;
}
function famMembersOf(user) {
  const fid = db.users[user]?.familyId;
  if (!fid || !db.families[fid]) return [];
  return db.families[fid].members || [];
}
/* 按登录用户过滤可见数据：自己 + 家庭成员 + 示例 */
function filterFor(user) {
  if (!user) {
    return {
      records: db.records.filter(r => r.owner === "system"),
      routes: db.routes.filter(r => r.owner === "system")
    };
  }
  const fam = famMembersOf(user);
  const can = (o) => o === "system" || o === user || fam.includes(o);
  return {
    records: db.records.filter(r => can(r.owner)),
    routes: db.routes.filter(r => can(r.owner))
  };
}

/* ---------------- 示例数据播种（服务端，首次运行） ---------------- */
function svgAsset(c1, c2, emoji, label, w = 480, h = 360) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${w * 0.85}" cy="${h * 0.2}" r="${h * 0.25}" fill="rgba(255,255,255,.15)"/>
    <circle cx="${w * 0.12}" cy="${h * 0.9}" r="${h * 0.35}" fill="rgba(255,255,255,.08)"/>
    <text x="${w / 2}" y="${h / 2 + 10}" font-size="${h * 0.25}" text-anchor="middle">${emoji}</text>
    <text x="${w / 2}" y="${h / 2 + h * 0.28}" font-size="${h * 0.055}" fill="rgba(255,255,255,.9)" text-anchor="middle" font-family="sans-serif">${label}</text>
  </svg>`;
}
async function seedIfEmpty() {
  if (db.seeded) return;
  const A = async (emoji, c1, c2, label, i) => {
    const id = `sys_ast_${i}`;
    await putAsset(id, Buffer.from(svgAsset(c1, c2, emoji, label)), "image/svg+xml");
    return id;
  };
  const t = Date.now();
  db.records.push(
    {
      id: "sys_rec_1", province: "湖北省", city: "恩施土家族苗族自治州",
      cover: await A("🌄", "#0f6f6f", "#8ad0b0", "恩施大峡谷", 1),
      dateStart: "2025-04-05", dateEnd: "2025-04-08",
      desc: "家门口的仙境！漂浮的小船刷爆了朋友圈，大峡谷的云海像牛奶一样。",
      tags: ["屏山峡谷", "恩施大峡谷", "女儿城"],
      media: [
        { id: "sys_m_1", type: "image", asset: await A("🚣", "#1f8a70", "#bde8a8", "屏山小船", 2), title: "悬浮的小船", starred: true, owner: "system" },
        { id: "sys_m_2", type: "image", asset: await A("⛰️", "#2f7d5a", "#a0d8a8", "大峡谷", 3), title: "云海与一炷香", starred: false, owner: "system" }
      ],
      owner: "system", createdAt: t - 86400000 * 10
    },
    {
      id: "sys_rec_2", province: "海南省", city: "三亚市",
      cover: await A("🌅", "#0f9b8e", "#ffe66d", "亚龙湾日出", 4),
      dateStart: "2022-07-20", dateEnd: "2022-07-27",
      desc: "第一次全家看海！爸爸被浪扑了个正着，笑声比海浪还大。",
      tags: ["亚龙湾", "蜈支洲岛", "天涯海角"],
      media: [
        { id: "sys_m_3", type: "image", asset: await A("🏝️", "#ff9a3d", "#ffd166", "海边日落", 5), title: "海边的黄昏", starred: true, owner: "system" },
        { id: "sys_m_4", type: "image", asset: await A("🌊", "#1479c8", "#7fd8e8", "蜈支洲岛", 6), title: "清澈见底", starred: false, owner: "system" }
      ],
      owner: "system", createdAt: t - 86400000 * 40
    },
    {
      id: "sys_rec_3", province: "甘肃省", city: "兰州市",
      cover: await A("🐫", "#d97b29", "#ffd28f", "鸣沙山驼队", 7),
      dateStart: "2024-10-02", dateEnd: "2024-10-06",
      desc: "自驾最远的一次，莫高窟的千年壁画让人说不出话。",
      tags: ["莫高窟", "鸣沙山", "月牙泉"],
      media: [
        { id: "sys_m_5", type: "image", asset: await A("🏜️", "#c94b0c", "#f2a93b", "大漠落日", 8), title: "沙漠的黄昏", starred: true, owner: "system" }
      ],
      owner: "system", createdAt: t - 86400000 * 90
    }
  );
  db.routes.push(
    { id: "sys_rt_1", from: { name: "湖北省 · 武汉市", coord: [114.31, 30.59] }, to: { name: "北京市", coord: [116.40, 39.90] }, owner: "system", createdAt: t },
    { id: "sys_rt_2", from: { name: "湖北省 · 武汉市", coord: [114.31, 30.59] }, to: { name: "海南省 · 三亚市", coord: [109.51, 18.25] }, owner: "system", createdAt: t }
  );
  db.seeded = true;
  saveDb();
  console.log("✅ 已播种示例数据");
}

/* ---------------- 请求体读取 ---------------- */
function readBody(req, limit = 120 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  try { return JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString("utf-8")) || {}; }
  catch { return {}; }
}
function userOfToken(body) {
  const tk = body.token || body._token;
  if (!tk) return null;
  const u = db.tokens[tk];
  return u && db.users[u] ? u : null;
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8"
};
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(ROOT, p));
  // 防目录穿越 & 禁止访问云端数据
  if (!file.startsWith(ROOT) || file.startsWith(DATA_DIR)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }); return res.end("404 Not Found"); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(buf);
  });
}

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname, query) {
  const send = (str, code = 200) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }); res.end(str); };

  /* ---- 健康检查 ---- */
  if (req.method === "GET" && pathname === "/api/ping")
    return send(ok({ cloud: true, version: 2, pg: !!pgPool, pgError }));

  /* ---- 存储体检：数据库多大、照片占了多少、有多少"无主"照片 ---- */
  if (req.method === "GET" && pathname === "/api/storage") {
    if (!pgPool) return send(ok({ pg: false, local: true }));
    try {
      const dbSize = (await pgPool.query(`SELECT pg_database_size(current_database()) AS s`)).rows[0].s;
      const ast = (await pgPool.query(
        `SELECT count(*)::int AS n, COALESCE(sum(length(data)),0)::bigint AS bytes, COALESCE(max(length(data)),0)::bigint AS max
         FROM ft_assets`
      )).rows[0];
      const stateSize = (await pgPool.query(
        `SELECT COALESCE(length(data::text),0)::bigint AS s FROM app_state WHERE k='main'`
      )).rows[0].s;
      /* 统计"无主照片"：库里存在、但没有任何记录引用它（删除记录后残留的孤儿文件） */
      const used = new Set();
      for (const r of db.records || []) {
        if (r.cover) used.add(r.cover);
        (r.media || []).forEach(m => { if (m.asset) used.add(m.asset); });
      }
      const orphans = Object.keys(db.assetsMeta || {}).filter(id => !used.has(id));
      let orphanBytes = 0;
      for (const id of orphans) orphanBytes += (db.assetsMeta[id] && db.assetsMeta[id].size) || 0;
      return send(ok({
        pg: true,
        dbBytes: Number(dbSize),
        assets: { count: ast.n, bytes: Number(ast.bytes), maxBytes: Number(ast.max) },
        stateBytes: Number(stateSize),
        orphanCount: orphans.length,
        orphanBytes,
        recordCount: (db.records || []).length,
        mb: {
          db: +(Number(dbSize) / 1048576).toFixed(1),
          assets: +(Number(ast.bytes) / 1048576).toFixed(1),
          state: +(Number(stateSize) / 1048576).toFixed(2),
          orphan: +(orphanBytes / 1048576).toFixed(1)
        }
      }));
    } catch (e) {
      return send(bad("体检失败：" + (e && e.message ? e.message : String(e))), 500);
    }
  }

  /* ---- 数据体检（诊断用：谁的记录还在库里，不含任何照片内容） ---- */
  if (req.method === "GET" && pathname === "/api/diag") {
    const byOwner = {};
    (db.records || []).forEach(r => { byOwner[r.owner || "?"] = (byOwner[r.owner || "?"] || 0) + 1; });
    const fams = Object.entries(db.families || {}).map(([id, f]) => ({
      id, name: f.name, code: f.code, members: f.members || []
    }));
    return send(ok({
      userCount: Object.keys(db.users || {}).length,
      users: Object.keys(db.users || {}),
      recordsByOwner: byOwner,
      recordTotal: (db.records || []).length,
      routeTotal: (db.routes || []).length,
      assetMetaCount: Object.keys(db.assetsMeta || {}).length,
      families: fams,
      seeded: !!db.seeded
    }));
  }

  /* ---- 一键清理：删除"无主照片"并回收数据库空间 ---- */
  if (req.method === "POST" && pathname === "/api/storage/cleanup") {
    const body2 = await readJson(req);
    const tk = query.get("token") || body2.token;
    if (!tk || !db.tokens[tk]) return send(bad("请先登录网站后再来清理", 401), 401);
    if (!pgPool) return send(bad("当前未使用云数据库，无需清理"));
    try {
      const used = new Set();
      for (const r of db.records || []) {
        if (r.cover) used.add(r.cover);
        (r.media || []).forEach(m => { if (m.asset) used.add(m.asset); });
      }
      const orphans = Object.keys(db.assetsMeta || {}).filter(id => !used.has(id));
      let freed = 0;
      if (orphans.length) {
        /* 一次 SQL 批量删除（逐条删太慢，会被网关超时掐断返回 HTML 错误页） */
        for (const id of orphans) freed += (db.assetsMeta[id] && db.assetsMeta[id].size) || 0;
        await pgPool.query(`DELETE FROM ft_assets WHERE id = ANY($1)`, [orphans]);
        for (const id of orphans) delete db.assetsMeta[id];
        saveDb();
      }
      /* 后台轻整理：普通 VACUUM（不锁表、不重写大表）；不用 VACUUM FULL，它会独占锁导致新实例启动被卡死 → 503 */
      pgPool.query(`VACUUM ft_assets`).catch(e => console.warn("VACUUM ft_assets:", e.message));
      pgPool.query(`VACUUM app_state`).catch(e => console.warn("VACUUM app_state:", e.message));
      console.log(`🧹 清理完成：删除 ${orphans.length} 个无主资产，释放约 ${(freed / 1048576).toFixed(1)} MB`);
      return send(ok({
        removed: orphans.length, freedBytes: freed,
        freedMB: +(freed / 1048576).toFixed(1),
        note: "空间已删除并可在后台复用；页面数字完全回落可能需要几分钟（后台整理中）"
      }));
    } catch (e) {
      return send(bad("清理失败：" + (e && e.message ? e.message : String(e))), 500);
    }
  }

  /* ---- 资产（照片/视频/Live图） ---- */
  const assetMatch = pathname.match(/^\/api\/asset\/([\w-]+)$/);
  if (assetMatch) {
    const id = assetMatch[1];
    if (req.method === "PUT") {
      try {
        const body = await readBody(req);
        const type = req.headers["x-file-type"] || "application/octet-stream";
        await putAsset(id, body, type); saveDb();
        return send(ok({ id, size: body.length }));
      } catch (e) {
        console.error("资产上传失败:", e);
        return send(bad("上传失败：" + (e && e.message ? e.message : String(e))), 500);
      }
    }
    if (req.method === "GET") {
      const a = await getAssetBuf(id);
      if (!a) return send(bad("资产不存在", 404), 404);
      res.writeHead(200, { "Content-Type": a.type, "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*" });
      return res.end(a.buf);
    }
    if (req.method === "DELETE") {
      await delAsset(id);
      saveDb();
      return send(ok());
    }
  }

  /* ---- 其余均需 JSON ---- */
  const body = await readJson(req);
  const me = userOfToken(body);

  /* ---- 注册 ---- */
  if (req.method === "POST" && pathname === "/api/auth/register") {
    const { user, pass } = body;
    if (!user || !pass) return send(bad("参数缺失"));
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,12}$/.test(user)) return send(bad("昵称需为 2-12 位中文/字母/数字/下划线"));
    if (String(pass).length < 4) return send(bad("密码至少 4 位"));
    if (db.users[user]) return send(bad("这个昵称已经被使用过了～"));
    const salt = crypto.randomBytes(8).toString("hex");
    db.users[user] = { salt, hash: sha256(salt + pass), familyId: null, createdAt: Date.now() };
    const token = randToken(); db.tokens[token] = user;
    saveDb();
    console.log(`👤 注册: ${user}`);
    return send(ok({ token, user }));
  }

  /* ---- 登录 ---- */
  if (req.method === "POST" && pathname === "/api/auth/login") {
    const { user, pass } = body;
    const u = user && db.users[user];
    if (!u) return send(bad("账号不存在，可切换到「注册」创建"));
    if (u.hash !== sha256(u.salt + pass)) return send(bad("密码不对哦，再想想？"));
    const token = randToken(); db.tokens[token] = user;
    saveDb();
    console.log(`🔑 登录: ${user}`);
    return send(ok({ token, user }));
  }

  /* ---- 退出 ---- */
  if (req.method === "POST" && pathname === "/api/auth/logout") {
    if (body.token) delete db.tokens[body.token];
    saveDb();
    return send(ok());
  }

  /* ---- 拉取全量状态（按家庭过滤） ---- */
  if (req.method === "GET" && pathname === "/api/state") {
    const token = query.get("token");
    const user = token && db.tokens[token] && db.users[db.tokens[token]] ? db.tokens[token] : null;
    const filtered = filterFor(user);
    return send(ok({
      user,
      users: usersPublic(),
      families: user ? db.families : {},
      records: filtered.records,
      routes: filtered.routes,
      assetIds: Object.keys(db.assetsMeta || {})
    }));
  }

  /* ---- 推送数据（按权限合并，绝不覆盖推送者看不见的其他家庭数据） ---- */
  if (req.method === "POST" && pathname === "/api/sync") {
    if (!me) return send(bad("请先登录", 401), 401);
    const { key, data } = body;
    if (!["records", "routes", "families"].includes(key)) return send(bad("不允许同步该数据类型"));
    if (key === "families") {
      db.families = data || {};
    } else {
      const fam = famMembersOf(me);
      const canEdit = (owner) => owner === me || owner === "system" || fam.includes(owner);
      const visible = filterFor(me)[key];                       // 我能看见的旧数据
      const incoming = Array.isArray(data) ? data : [];
      const byId = new Map(incoming.map(x => [x.id, x]));
      /* 删除：在我可见范围内、但新列表里已不存在 → 视为我删除了它 */
      let next = db[key].filter(r => {
        if (!visible.some(v => v.id === r.id)) return true;      // 不在我可见范围 → 一律保留（别人家的数据）
        return byId.has(r.id);
      });
      /* 新增 / 更新（仅有权限的记录会被覆盖） */
      for (const item of incoming) {
        if (!item || !item.id) continue;
        const i = next.findIndex(r => r.id === item.id);
        if (i >= 0) { if (canEdit(next[i].owner)) next[i] = item; }
        else next.push(item);
      }
      db[key] = next;
    }
    saveDb();
    return send(ok());
  }

  /* ---- 家庭：创建 / 加入 / 退出 ---- */
  if (req.method === "POST" && pathname === "/api/family/create") {
    if (!me) return send(bad("请先登录", 401), 401);
    const name = String(body.name || "").trim();
    if (name.length < 2) return send(bad("请给家庭起个 2 字以上的名字～"));
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); }
    while (Object.values(db.families).some(f => f.code === code));
    const famId = "fam" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    db.families[famId] = { name, code, members: [me], createdAt: Date.now() };
    db.users[me].familyId = famId;
    saveDb();
    console.log(`🏠 ${me} 创建家庭「${name}」(${code})`);
    return send(ok({ famId, family: db.families[famId] }));
  }
  if (req.method === "POST" && pathname === "/api/family/join") {
    if (!me) return send(bad("请先登录", 401), 401);
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) return send(bad("请输入 6 位家庭邀请码"));
    const entry = Object.entries(db.families).find(([, f]) => f.code === code);
    if (!entry) return send(bad("邀请码不存在，检查一下大小写？"));
    const [famId, fam] = entry;
    if (!fam.members.includes(me)) fam.members.push(me);
    db.users[me].familyId = famId;
    saveDb();
    console.log(`🤝 ${me} 加入家庭「${fam.name}」`);
    return send(ok({ famId, family: fam }));
  }
  if (req.method === "POST" && pathname === "/api/family/leave") {
    if (!me) return send(bad("请先登录", 401), 401);
    const fid = db.users[me].familyId;
    if (fid && db.families[fid]) {
      db.families[fid].members = db.families[fid].members.filter(m => m !== me);
      if (!db.families[fid].members.length) delete db.families[fid];
    }
    db.users[me].familyId = null;
    saveDb();
    return send(ok());
  }

  return send(bad("接口不存在", 404), 404);
}

/* ---------------- 启动 ---------------- */
/* 重要：先监听端口（让平台健康检查立刻通过），再去初始化数据库。
   以前是「先连数据库再监听」，数据库一旦卡住/写满，服务永远起不来 → 网页一直 503。 */
function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,X-File-Type"
        });
        return res.end();
      }
      if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname, url.searchParams);
      return serveStatic(req, res, pathname);
    } catch (e) {
      console.error("请求处理出错:", e);
      try { res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }); res.end(bad("服务器内部错误: " + (e && e.message ? e.message : String(e)))); } catch {}
    }
  });
  server.listen(PORT, HOST, () => {
    console.log("-family--------------------------------------");
    console.log(`  🧳 家庭旅行网站 · 云同步版已启动`);
    console.log(`  存储: ${pgPool ? "☁️ 云端 Postgres（数据永久保存）" : "📁 本地文件 cloud-data/"}`);
    console.log(`  🌐 本机访问:   http://localhost:${PORT}`);
    console.log(`  📱 局域网访问: http://<你的IP>:${PORT}  （家人手机连同一 WiFi 即可打开）`);
    console.log("-family--------------------------------------");
    /* 端口已可访问后再慢慢连数据库，失败也只是降级，不影响网页打开 */
    initStore()
      .catch(e => console.error("数据库初始化失败（已降级，网页仍可打开）:", e && e.message))
      .then(() => migrateFromOld());   /* 若设置了 MIGRATE_FROM_URL，自动把旧库数据搬到新库 */
  });
}

/* ---------------- 一次性数据搬迁：旧库（已满/只读）→ 新库 ----------------
 * 用法：CloudBase 环境变量里设 DATABASE_URL=新库连接串、MIGRATE_FROM_URL=旧库连接串。
 * 服务启动后自动：①复制账号/家庭/记录/路线；②逐张复制照片（跳过无主孤儿，节省空间）。
 * 完成后日志会提示删除 MIGRATE_FROM_URL（不删的话每次启动都会重搬一遍，但已有数据会跳过，无害）。 */
async function migrateFromOld() {
  const oldUrl = process.env.MIGRATE_FROM_URL;
  if (!oldUrl || !pgPool) return;
  let old;
  try {
    const { Pool } = require("pg");
    old = new Pool({
      connectionString: oldUrl,
      ssl: { rejectUnauthorized: false },
      max: 2,
      connectionTimeoutMillis: 10000,
      options: "-c statement_timeout=60000"
    });
  } catch (e) { console.error("搬迁：无法连接旧库", e.message); return; }
  try {
    console.log("🚚 [搬迁] 开始从旧数据库搬运数据…");
    /* ① 搬 app_state（账号/家庭/记录/路线/assetsMeta 全在里面） */
    const st = await old.query(`SELECT data FROM app_state WHERE k = 'main'`);
    if (st.rows[0]) {
      const data = st.rows[0].data;
      await pgPool.query(
        `INSERT INTO app_state (k, data) VALUES ('main', $1) ON CONFLICT (k) DO UPDATE SET data = $1`,
        [JSON.stringify(data)]
      );
      db = Object.assign({ users: {}, families: {}, records: [], routes: [], tokens: {}, assetsMeta: {} }, data);
      db.assetsMeta = db.assetsMeta || {};
      console.log(`✅ [搬迁] 账号/记录已搬：${(db.records || []).length} 条记录`);
    }
    /* ② 搬照片：只搬被记录引用的（跳过孤儿省空间），跳过新库已有的 */
    const used = new Set();
    for (const rec of db.records || []) {
      if (rec.cover) used.add(rec.cover);
      (rec.media || []).forEach(m => { if (m.asset) used.add(m.asset); });
    }
    const have = new Set((await pgPool.query(`SELECT id FROM ft_assets`)).rows.map(x => x.id));
    const allIds = (await old.query(`SELECT id FROM ft_assets`)).rows.map(x => x.id);
    const ids = allIds.filter(id => used.has(id) && !have.has(id));
    console.log(`🚚 [搬迁] 旧库共 ${allIds.length} 个文件，需搬运 ${ids.length} 个（其余为孤儿或已存在）`);
    let done = 0, fail = 0;
    for (const id of ids) {
      try {
        const a = await old.query(`SELECT type, data FROM ft_assets WHERE id = $1`, [id]);
        if (!a.rows[0]) continue;
        await pgPool.query(
          `INSERT INTO ft_assets (id, type, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
          [id, a.rows[0].type, a.rows[0].data]
        );
        db.assetsMeta[id] = db.assetsMeta[id] || { type: a.rows[0].type, size: a.rows[0].data.length, at: Date.now() };
        done++;
        if (done % 200 === 0) console.log(`🚚 [搬迁] 进度 ${done}/${ids.length}`);
      } catch (e) { fail++; console.warn(`[搬迁] ${id} 失败:`, e.message); }
    }
    saveDb();
    console.log(`🎉 [搬迁] 完成！成功 ${done}，失败 ${fail}。请到 CloudBase 删除 MIGRATE_FROM_URL 环境变量。`);
  } catch (e) {
    console.error("搬迁失败:", e && e.message);
  } finally {
    await old.end().catch(() => {});
  }
}

startServer();
