/* ============================================================
 * core.js — 工具 / 资产库(IndexedDB) / 认证 / 家庭
 * ============================================================ */
window.FT = {};

/* ---------- 基础工具 ---------- */
FT.$ = (s, p) => (p || document).querySelector(s);
FT.$$ = (s, p) => Array.from((p || document).querySelectorAll(s));
FT.uid = (pre) => (pre || "id") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
FT.esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
FT.fmtDate = (ts) => new Date(ts).toLocaleDateString("zh-CN");
FT.dateRange = (r) => {
  const s = r.dateStart || r.date || "";
  const e = r.dateEnd || r.dateStart || r.date || "";
  if (!s) return "未设置日期";
  const f = (d) => String(d).replaceAll("-", ".");
  return s === e ? f(s) : `${f(s)} — ${f(e)}`;
};
FT.toast = (msg) => {
  const t = FT.$("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2800);
};
FT.hash = (str) => {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return "h" + h.toString(36);
};

FT.store = {
  get(key, def) { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch { FT.toast("本地空间已满，请删除部分照片/视频后再试"); return false; }
  }
};

FT.LS = {
  users: "ft_users",      // { username: { pass, familyId, createdAt } }
  session: "ft_session",  // username
  families: "ft_families",// { famId: { name, code, members: [], createdAt } }
  records: "ft_records",  // [record]
  routes: "ft_routes",    // [route]
  seeded: "ft_seeded_v2"
};

/* ============================================================
 * Assets — IndexedDB 二进制资产库（照片 / 视频 / 封面）
 * 元数据存 localStorage，Blob 存 IndexedDB，避免 5MB 限制
 * ============================================================ */
FT.Assets = {
  _db: null,
  _urlCache: new Map(),

  open() {
    return new Promise((resolve) => {
      const req = indexedDB.open("ft-media", 1);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore("assets");
      };
      req.onsuccess = (e) => { this._db = e.target.result; resolve(true); };
      req.onerror = () => { console.warn("IndexedDB 打开失败"); resolve(false); };
    });
  },
  _tx(mode) {
    return this._db.transaction("assets", mode).objectStore("assets");
  },
  put(id, blob) {
    return new Promise((resolve, reject) => {
      if (!this._db) return reject(new Error("db 未就绪"));
      const r = this._tx("readwrite").put(blob, id);
      r.onsuccess = () => resolve(id);
      r.onerror = () => reject(r.error);
    });
  },
  get(id) {
    return new Promise((resolve) => {
      if (!this._db) return resolve(null);
      const r = this._tx("readonly").get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  },
  del(id) {
    const url = this._urlCache.get(id);
    if (url) { URL.revokeObjectURL(url); this._urlCache.delete(id); }
    if (!this._db) return;
    try { this._tx("readwrite").delete(id); } catch {}
  },
  async url(id) {
    if (!id) return "";
    if (this._urlCache.has(id)) return this._urlCache.get(id);
    const blob = await this.get(id);
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    this._urlCache.set(id, url);
    return url;
  },

  /* 图片压缩（GIF 保持原样以保留动图） */
  async compressImage(file, maxDim = 1600, quality = 0.86) {
    if (file.type === "image/gif" || file.type === "image/svg+xml") return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      if (scale >= 1 && file.size < 900 * 1024) return file;
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", quality));
      return blob && blob.size < file.size ? blob : file;
    } catch { return file; }
  }
};

/* 生成 SVG 渐变占位 Blob（示例数据用） */
FT.svgBlob = (c1, c2, emoji, label, w = 480, h = 360) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${w * 0.85}" cy="${h * 0.2}" r="${h * 0.25}" fill="rgba(255,255,255,.15)"/>
    <circle cx="${w * 0.12}" cy="${h * 0.9}" r="${h * 0.35}" fill="rgba(255,255,255,.08)"/>
    <text x="${w / 2}" y="${h / 2 + 10}" font-size="${h * 0.25}" text-anchor="middle">${emoji}</text>
    <text x="${w / 2}" y="${h / 2 + h * 0.28}" font-size="${h * 0.055}" fill="rgba(255,255,255,.9)" text-anchor="middle" font-family="sans-serif">${label}</text>
  </svg>`;
  return new Blob([svg], { type: "image/svg+xml" });
};

/* ============================================================
 * Auth — 登录 / 注册
 * ============================================================ */
FT.Auth = {
  user: null,
  mode: "login", // login | register | family-setup

  users() { return FT.store.get(FT.LS.users, {}); },
  saveUsers(u) { FT.store.set(FT.LS.users, u); },

  init() {
    const s = FT.store.get(FT.LS.session, null);
    if (s && this.users()[s]) this.user = s;

    FT.$("#loginBtn").addEventListener("click", () => this.open());
    FT.$("#logoutBtn").addEventListener("click", () => this.logout());
    FT.$("#authClose").addEventListener("click", () => this.close());
    FT.$("#authModal").addEventListener("click", e => { if (e.target.id === "authModal") this.close(); });
    FT.$("#authForm").addEventListener("submit", e => { e.preventDefault(); this.submit(); });
    FT.$$(".auth-tab").forEach(t => t.addEventListener("click", () => {
      if (this.mode === "family-setup") return;
      this.mode = t.dataset.mode;
      this.render();
    }));
    FT.$("#famCreateBtn").addEventListener("click", () => FT.Family.createFromInput());
    FT.$("#famJoinBtn").addEventListener("click", () => FT.Family.joinFromInput());
    FT.$("#famSkip").addEventListener("click", () => this.close());
    this.render();
  },

  open(mode) {
    if (mode) this.mode = mode;
    else if (!this.user) this.mode = "login";
    else if (!this.userFamily()) this.mode = "family-setup";
    else this.mode = "login";
    FT.$("#authModal").classList.remove("hidden");
    this.render();
  },
  close() { FT.$("#authModal").classList.add("hidden"); },

  submit() {
    const user = FT.$("#authUser").value.trim();
    const pass = FT.$("#authPass").value;
    const pass2 = FT.$("#authPass2").value;
    const err = FT.$("#authError");
    err.classList.add("hidden");

    if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,12}$/.test(user))
      return this.fail("昵称需为 2-12 位中文 / 字母 / 数字 / 下划线");
    if (pass.length < 4) return this.fail("密码至少 4 位");

    const users = this.users();
    if (this.mode === "register") {
      if (users[user]) return this.fail("这个昵称已经被使用过了～");
      if (pass !== pass2) return this.fail("两次输入的密码不一致");
      users[user] = { pass: FT.hash(pass), familyId: null, createdAt: Date.now() };
      this.saveUsers(users);
      this._loginAs(user);
      FT.toast(`欢迎加入，${user}！现在创建或加入一个家庭吧 🏠`);
      this.mode = "family-setup";
      this.render();
    } else {
      if (!users[user]) return this.fail("账号不存在，可切换到「注册」创建");
      if (users[user].pass !== FT.hash(pass)) return this.fail("密码不对哦，再想想？");
      this._loginAs(user);
      if (!users[user].familyId) { this.mode = "family-setup"; this.render(); }
      else { this.close(); FT.toast(`欢迎回来，${user}！👋`); }
    }
  },
  fail(msg) { const e = FT.$("#authError"); e.textContent = msg; e.classList.remove("hidden"); },

  _loginAs(user) {
    FT.store.set(FT.LS.session, user);
    this.user = user;
    this.render();
    FT.refreshAll();
  },

  logout() {
    localStorage.removeItem(FT.LS.session);
    this.user = null;
    this.render();
    FT.$("#familyPanel").classList.add("hidden");
    FT.refreshAll();
    FT.toast("已退出登录 📦");
  },

  userFamily() {
    if (!this.user) return null;
    const fid = this.users()[this.user]?.familyId;
    if (!fid) return null;
    return FT.store.get(FT.LS.families, {})[fid] || null;
  },

  render() {
    const logged = !!this.user;
    FT.$("#loginBtn").classList.toggle("hidden", logged);
    FT.$("#userChip").classList.toggle("hidden", !logged);
    if (logged) {
      FT.$("#userName").textContent = this.user;
      FT.$("#userAvatar").textContent = this.user.slice(0, 1);
    }
    const fam = this.userFamily();
    FT.$("#familyChip").classList.toggle("hidden", !(logged && fam));
    if (fam) FT.$("#familyChipName").textContent = fam.name;

    // 弹窗内容切换
    FT.$$(".auth-tab").forEach(t => t.classList.toggle("active", t.dataset.mode === this.mode));
    FT.$("#authForm").classList.toggle("hidden", this.mode === "family-setup");
    FT.$("#authFamilySetup").classList.toggle("hidden", this.mode !== "family-setup");
    FT.$("#authPass2Wrap").classList.toggle("hidden", this.mode !== "register");
    FT.$("#authSubmit").textContent = this.mode === "register" ? "注 册" : "登 录";
    FT.$("#authError").classList.add("hidden");
  }
};

/* ============================================================
 * Family — 家庭创建 / 邀请码加入 / 成员共享
 * ============================================================ */
FT.Family = {
  all() { return FT.store.get(FT.LS.families, {}); },
  saveAll(f) { FT.store.set(FT.LS.families, f); },

  genCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const all = this.all();
    let code;
    do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); }
    while (Object.values(all).some(f => f.code === code));
    return code;
  },

  createFromInput() {
    if (!FT.Auth.user) return FT.Auth.open();
    const name = FT.$("#famCreateName").value.trim();
    if (!name || name.length < 2) return FT.toast("请给家庭起个 2 字以上的名字～");
    const famId = FT.uid("fam");
    const families = this.all();
    families[famId] = { name, code: this.genCode(), members: [FT.Auth.user], createdAt: Date.now() };
    this.saveAll(families);
    this._bindFamily(famId);
    FT.Auth.close();
    FT.toast(`「${name}」创建成功！邀请码：${families[famId].code} 🎉`);
    FT.refreshAll();
  },

  joinFromInput() {
    if (!FT.Auth.user) return FT.Auth.open();
    const code = FT.$("#famJoinCode").value.trim().toUpperCase();
    if (!code) return FT.toast("请输入 6 位家庭邀请码");
    const families = this.all();
    const fam = Object.values(families).find(f => f.code === code);
    if (!fam) return FT.toast("邀请码不存在，检查一下大小写？");
    if (fam.members.includes(FT.Auth.user)) return FT.toast("你已经是这个家庭的成员啦～");
    fam.members.push(FT.Auth.user);
    this.saveAll(families);
    this._bindFamily(Object.keys(families).find(k => families[k] === fam));
    FT.Auth.close();
    FT.toast(`已加入「${fam.name}」！现在可以共享照片了 🎉`);
    FT.refreshAll();
  },

  _bindFamily(famId) {
    const users = FT.Auth.users();
    users[FT.Auth.user].familyId = famId;
    FT.Auth.saveUsers(users);
    FT.Auth.render();
  },

  leave() {
    if (!FT.Auth.user) return;
    const users = FT.Auth.users();
    const fid = users[FT.Auth.user].familyId;
    if (!fid) return;
    const families = this.all();
    if (families[fid]) {
      families[fid].members = families[fid].members.filter(m => m !== FT.Auth.user);
      if (!families[fid].members.length) delete families[fid];
      else this.saveAll(families);
    }
    users[FT.Auth.user].familyId = null;
    FT.Auth.saveUsers(users);
    FT.Auth.render();
    FT.$("#familyPanel").classList.add("hidden");
    FT.refreshAll();
    FT.toast("已退出家庭，你的照片仍保留在自己账号下");
  },

  /* ---------- 家庭信息面板 ---------- */
  initPanel() {
    FT.$("#familyChip").addEventListener("click", () => this.renderPanel());
    FT.$("#familyPanelClose").addEventListener("click", () => FT.$("#familyPanel").classList.add("hidden"));
    FT.$("#familyPanel").addEventListener("click", e => { if (e.target.id === "familyPanel") e.target.classList.add("hidden"); });
    FT.$("#famPanelLeave").addEventListener("click", () => {
      if (confirm("确定退出当前家庭吗？退出后将无法查看家庭成员的照片。")) this.leave();
    });
    FT.$("#famPanelCopy").addEventListener("click", () => {
      const code = FT.$("#famPanelCode").textContent;
      navigator.clipboard?.writeText(code).then(() => FT.toast("邀请码已复制，发给家人吧 ✉️"));
    });
    FT.$("#famPanelSetup").addEventListener("click", () => {
      FT.$("#familyPanel").classList.add("hidden");
      FT.Auth.open("family-setup");
    });
  },

  renderPanel() {
    const panel = FT.$("#familyPanel");
    const fam = FT.Auth.userFamily();
    const myId = FT.Auth.users()[FT.Auth.user]?.familyId;
    if (!fam) {
      FT.$("#famPanelInfo").classList.add("hidden");
      FT.$("#famPanelEmpty").classList.remove("hidden");
      panel.classList.remove("hidden");
      return;
    }
    FT.$("#famPanelEmpty").classList.add("hidden");
    FT.$("#famPanelInfo").classList.remove("hidden");
    FT.$("#famPanelName").textContent = "🏠 " + fam.name;
    FT.$("#famPanelCode").textContent = fam.code;
    FT.$("#famPanelMembers").innerHTML = fam.members.map(m => `
      <div class="fam-member">
        <span class="avatar" style="background:hsl(${[...m].reduce((s,c)=>s+c.charCodeAt(0),0)%360},60%,55%)">${FT.esc(m.slice(0,1))}</span>
        <b>${FT.esc(m)}</b>
        ${m === FT.Auth.user ? "<i>(我)</i>" : ""}
      </div>`).join("");
    panel.classList.remove("hidden");
  }
};

/* ============================================================
 * 权限：家庭成员之间共享，非成员不可见他人照片
 * ============================================================ */
FT.canView = (owner) => {
  if (owner === "system") return true;                    // 示例数据人人可见
  if (!FT.Auth.user) return false;                        // 未登录只能看示例
  if (owner === FT.Auth.user) return true;                // 自己
  const fam = FT.Auth.userFamily();
  return !!(fam && fam.members.includes(owner));          // 家庭成员
};
FT.ownerName = (owner) => owner === "system" ? "示例" : owner;

/* ============================================================
 * 示例数据（首次运行时播种）
 * ============================================================ */
FT.seed = async () => {
  if (FT.store.get(FT.LS.seeded, false)) return;

  async function addAsset(emoji, c1, c2, label) {
    const id = FT.uid("ast");
    await FT.Assets.put(id, FT.svgBlob(c1, c2, emoji, label));
    return id;
  }

  const records = [];

  // 示例记录 1：恩施
  {
    const cover = await addAsset("🌄", "#0f6f6f", "#8ad0b0", "恩施大峡谷");
    const m1 = await addAsset("🚣", "#1f8a70", "#bde8a8", "屏山小船");
    const m2 = await addAsset("⛰️", "#2f7d5a", "#a0d8a8", "大峡谷");
    records.push({
      id: FT.uid("rec"), province: "湖北省", city: "恩施土家族苗族自治州",
      cover, dateStart: "2025-04-05", dateEnd: "2025-04-08",
      desc: "家门口的仙境！漂浮的小船刷爆了朋友圈，大峡谷的云海像牛奶一样。",
      tags: ["屏山峡谷", "恩施大峡谷", "女儿城"],
      media: [
        { id: FT.uid("m"), type: "image", asset: m1, title: "悬浮的小船", starred: true, owner: "system" },
        { id: FT.uid("m"), type: "image", asset: m2, title: "云海与一炷香", starred: false, owner: "system" }
      ],
      owner: "system", createdAt: Date.now() - 86400000 * 10
    });
  }
  // 示例记录 2：三亚
  {
    const cover = await addAsset("🌅", "#0f9b8e", "#ffe66d", "亚龙湾日出");
    const m1 = await addAsset("🏝️", "#ff9a3d", "#ffd166", "海边日落");
    const m2 = await addAsset("🌊", "#1479c8", "#7fd8e8", "蜈支洲岛");
    records.push({
      id: FT.uid("rec"), province: "海南省", city: "三亚市",
      cover, dateStart: "2022-07-20", dateEnd: "2022-07-27",
      desc: "第一次全家看海！爸爸被浪扑了个正着，笑声比海浪还大。",
      tags: ["亚龙湾", "蜈支洲岛", "天涯海角"],
      media: [
        { id: FT.uid("m"), type: "image", asset: m1, title: "海边的黄昏", starred: true, owner: "system" },
        { id: FT.uid("m"), type: "image", asset: m2, title: "清澈见底", starred: false, owner: "system" }
      ],
      owner: "system", createdAt: Date.now() - 86400000 * 40
    });
  }
  // 示例记录 3：敦煌
  {
    const cover = await addAsset("🐫", "#d97b29", "#ffd28f", "鸣沙山驼队");
    const m1 = await addAsset("🏜️", "#c94b0c", "#f2a93b", "大漠落日");
    records.push({
      id: FT.uid("rec"), province: "甘肃省", city: "兰州市",
      cover, dateStart: "2024-10-02", dateEnd: "2024-10-06",
      desc: "自驾最远的一次，莫高窟的千年壁画让人说不出话。",
      tags: ["莫高窟", "鸣沙山", "月牙泉"],
      media: [
        { id: FT.uid("m"), type: "image", asset: m1, title: "沙漠的黄昏", starred: true, owner: "system" }
      ],
      owner: "system", createdAt: Date.now() - 86400000 * 90
    });
  }
  FT.store.set(FT.LS.records, records);

  // 示例路线（地图）
  const routes = [
    { id: FT.uid("rt"), from: { name: "湖北省 · 武汉市", coord: [114.31, 30.59] }, to: { name: "北京市", coord: [116.40, 39.90] }, owner: "system", createdAt: Date.now() },
    { id: FT.uid("rt"), from: { name: "湖北省 · 武汉市", coord: [114.31, 30.59] }, to: { name: "海南省 · 三亚市", coord: [109.51, 18.25] }, owner: "system", createdAt: Date.now() }
  ];
  FT.store.set(FT.LS.routes, routes);
  FT.store.set(FT.LS.seeded, true);
};

/* 全局刷新（登录态 / 家庭变化后由各模块实现） */
FT.refreshAll = () => {
  ["Map", "Records", "Gallery", "Home", "Timeline"].forEach(k => {
    if (FT[k] && typeof FT[k].render === "function") FT[k].render();
  });
};
