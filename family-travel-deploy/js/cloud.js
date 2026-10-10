/* ============================================================
 * cloud.js — 云同步层
 * 探测后端（/api/ping）：
 *   · 云模式：注册/登录走云端验证；数据、照片双写（本地缓存+云端）；
 *     定时轮询云端，家人在别的设备上传的照片会自动出现。
 *   · 本地模式（用静态服务器直接打开时）：所有包装自动失效，
 *     网站行为与原来完全一致。
 * ============================================================ */
(function () {
  const FT = window.FT;
  if (!FT) return;

  const Cloud = {
    on: false,          // 是否处于云模式
    base: (new URLSearchParams(location.search).get("server") || localStorage.getItem("ft_server") || "").replace(/\/+$/, ""),
    token: localStorage.getItem("ft_cloud_token") || "",
    _pushQueue: {},     // 待推送的 key -> data
    _pushTimer: null,
    _pulling: false,
    _lastSnapshot: "",  // 上次拉取快照（变化才刷新界面）
    _firstSync: !localStorage.getItem("ft_cloud_synced"),

    url(p) { return this.base ? this.base + p : p; },
    api(path, body, method) {
      return fetch(this.url(path), Object.assign({
        method: method || (body ? "POST" : "GET"),
        headers: body ? { "Content-Type": "application/json" } : {}
      }, body ? { body: JSON.stringify(body) } : {}));
    },
    async json(path, body, method) {
      try {
        const r = await Cloud.api(path, body, method);
        return await r.json();
      } catch { return { ok: false, error: "网络异常，请检查连接" }; }
    }
  };
  window.FTCloud = Cloud;

  /* ---------- 探测后端 ---------- */
  Cloud.ready = Cloud.json(Cloud.url("/api/ping")).then(r => {
    Cloud.on = !!(r && r.cloud);
    if (Cloud.on) return Cloud.initialSync().catch(console.error);
  }).catch(() => { Cloud.on = false; });

  /* ---------- 首次同步：本地旧数据并入云端 ---------- */
  async function listLocalAssetKeys() {
    return new Promise(resolve => {
      try {
        const store = FT.Assets._db.transaction("assets", "readonly").objectStore("assets");
        const req = store.getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch { resolve([]); }
    });
  }

  Cloud.initialSync = async function () {
    if (!Cloud.on) return;
    const st = await Cloud.json(Cloud.url("/api/state") + (Cloud.token ? `?token=${encodeURIComponent(Cloud.token)}` : ""));
    if (!st.ok) return;

    if (Cloud._firstSync) {
      /* 把本地已有（非示例）的记录/路线/家庭合并上云端 */
      const merged = {};
      const mergeList = (key, remote) => {
        const local = FT.store.get(FT.LS[key], []);
        const map = new Map(remote.map(x => [x.id, x]));
        local.forEach(x => { if (!map.has(x.id)) map.set(x.id, x); });
        merged[key] = [...map.values()];
      };
      mergeList("records", st.records);
      mergeList("routes", st.routes);
      const famMap = Object.assign({}, st.families);
      const localFam = FT.store.get(FT.LS.families, {});
      for (const [k, v] of Object.entries(localFam)) if (!famMap[k]) famMap[k] = v;
      if (Cloud.token) {
        for (const key of ["records", "routes"]) {
          if (merged[key].length !== st[key].length)
            await Cloud.json(Cloud.url("/api/sync"), { token: Cloud.token, key, data: merged[key] });
        }
        if (Object.keys(famMap).length !== Object.keys(st.families).length)
          await Cloud.json(Cloud.url("/api/sync"), { token: Cloud.token, key: "families", data: famMap });

        /* 上传本地有、云端没有的照片资产 */
        const serverIds = new Set(st.assetIds || []);
        const keys = await listLocalAssetKeys();
        for (const id of keys) {
          if (serverIds.has(id)) continue;
          const blob = await FT.Assets.get(id);
          if (!blob) continue;
          try {
            await fetch(Cloud.url("/api/asset/") + id, {
              method: "PUT",
              headers: { "X-File-Type": blob.type || "application/octet-stream" },
              body: blob
            });
          } catch (e) { console.warn("资产上传失败", id, e); }
        }
      }
      localStorage.setItem("ft_cloud_synced", "1");
      Cloud._firstSync = false;
    }
    await Cloud.pull(true);
    startPolling();
  };

  /* ---------- 拉取云端状态 → 更新本地缓存 ---------- */
  Cloud.pull = async function (force) {
    if (!Cloud.on || Cloud._pulling) return;
    Cloud._pulling = true;
    try {
      const st = await Cloud.json(Cloud.url("/api/state") + (Cloud.token ? `?token=${encodeURIComponent(Cloud.token)}` : ""));
      if (!st.ok) return;

      /* 本地已登录但还没有云端会话（升级前注册的老账号）：
         不用服务器的过滤结果覆盖本地，提示重新登录一次即可全设备同步 */
      const session = FT.store.get(FT.LS.session, null);
      if (session && !Cloud.token) {
        FT.toast("登录一次即可把你的数据接入云端，实现全家共享 ☁");
        return;
      }

      const snap = JSON.stringify({ r: st.records, t: st.routes, f: st.families, u: st.users });
      if (!force && snap === Cloud._lastSnapshot) return;
      Cloud._lastSnapshot = snap;

      /* users 合并（云端优先，保留本地独有账号以兼容旧数据） */
      const localUsers = FT.store.get(FT.LS.users, {});
      const users = Object.assign({}, localUsers, st.users);
      for (const k of Object.keys(users)) if (st.users[k]) users[k] = st.users[k];
      FT.store.set(FT.LS.users, users);
      FT.store.set(FT.LS.families, st.families || {});
      FT.store.set(FT.LS.records, st.records || []);
      FT.store.set(FT.LS.routes, st.routes || []);

      FT.Auth.render();
      FT.refreshAll();

      /* 自动补传此前失败的照片（限频：60 秒一次） */
      const pend = pendList();
      if (pend.length && Date.now() - (Cloud._lastRetryAt || 0) > 60000) {
        Cloud._lastRetryAt = Date.now();
        (async () => {
          const remain = [];
          for (const id of pend) {
            const blob = await FT.Assets.get(id);
            if (!blob) continue;
            try {
              const r = await fetch(Cloud.url("/api/asset/") + id, {
                method: "PUT",
                headers: { "X-File-Type": blob.type || "application/octet-stream" },
                body: blob
              });
              if (!r.ok) remain.push(id);
            } catch { remain.push(id); }
          }
          pendSave(remain);
          if (remain.length < pend.length) FT.toast("部分照片已补传到云端 ☁");
        })().catch(() => {});
      }
    } finally { Cloud._pulling = false; }
  };

  /* ---------- 写操作 → 双写（本地 + 云端） ---------- */
  const origSet = FT.store.set.bind(FT.store);
  const CLOUD_KEY = { ft_records: "records", ft_routes: "routes", ft_families: "families" };
  FT.store.set = function (key, val) {
    const r = origSet(key, val);
    const ck = CLOUD_KEY[key];
    if (Cloud.on && !Cloud._pulling && ck && Cloud.token) {
      Cloud._pushQueue[ck] = val;
      clearTimeout(Cloud._pushTimer);
      Cloud._pushTimer = setTimeout(flushPush, 600);
    }
    return r;
  };
  async function flushPush() {
    if (!Cloud.token) return;
    const q = Cloud._pushQueue; Cloud._pushQueue = {};
    for (const [key, data] of Object.entries(q)) {
      const r = await Cloud.json(Cloud.url("/api/sync"), { token: Cloud.token, key, data });
      if (!r.ok) { Cloud._pushQueue[key] = data; FT.toast("云同步失败，稍后自动重试 ☁"); }
    }
  }

  /* ---------- 资产：put/del 同步云端，url 直连云端 ---------- */
  const origPut = FT.Assets.put.bind(FT.Assets);
  const origDel = FT.Assets.del.bind(FT.Assets);
  const PEND_KEY = "ft_pending_assets";
  function pendList() {
    try { return JSON.parse(localStorage.getItem(PEND_KEY) || "[]"); } catch { return []; }
  }
  function pendSave(list) {
    try { localStorage.setItem(PEND_KEY, JSON.stringify(list)); } catch {}
  }
  FT.Assets.put = async function (id, blob) {
    const r = await origPut(id, blob);           // 本地 IndexedDB
    if (Cloud.on && Cloud.token) {
      try {
        await fetch(Cloud.url("/api/asset/") + id, {
          method: "PUT",
          headers: { "X-File-Type": blob.type || "application/octet-stream" },
          body: blob
        });
        const p = pendList();                     // 上传成功则从待重试名单移除
        if (p.includes(id)) pendSave(p.filter(x => x !== id));
      } catch (e) {
        console.warn("云端上传失败", id, e);
        const p = pendList();
        if (!p.includes(id)) { p.push(id); pendSave(p); }
        FT.toast("照片已存本地，云端上传失败，稍后自动重试 ☁");
      }
    }
    return r;
  };
  FT.Assets.del = function (id) {
    origDel(id);
    pendSave(pendList().filter(x => x !== id));
    if (Cloud.on && Cloud.token)
      fetch(Cloud.url("/api/asset/") + id, { method: "DELETE" }).catch(() => {});
  };
  FT.Assets.url = async function (id) {
    if (!id) return "";
    if (Cloud.on) {
      /* 该资产云端上传失败过 → 用本地副本，本机仍能看到照片 */
      if (pendList().includes(id)) {
        const blob = await this.get(id);
        if (blob) return URL.createObjectURL(blob);
      }
      return Cloud.url("/api/asset/") + id;   // 云模式：直接用云端地址，任何设备都能看到
    }
    if (this._urlCache.has(id)) return this._urlCache.get(id);
    const blob = await this.get(id);
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    this._urlCache.set(id, url);
    return url;
  };

  /* ---------- 注册 / 登录：云端验证 ---------- */
  const origSubmit = FT.Auth.submit.bind(FT.Auth);
  FT.Auth.submit = async function () {
    if (!Cloud.on) return origSubmit();
    const user = FT.$("#authUser").value.trim();
    const pass = FT.$("#authPass").value;
    const pass2 = FT.$("#authPass2").value;
    const err = FT.$("#authError");
    err.classList.add("hidden");
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{2,12}$/.test(user))
      return this.fail("昵称需为 2-12 位中文 / 字母 / 数字 / 下划线");
    if (pass.length < 4) return this.fail("密码至少 4 位");

    if (this.mode === "register") {
      if (pass !== pass2) return this.fail("两次输入的密码不一致");
      const btn = FT.$("#authSubmit"); btn.disabled = true;
      const r = await Cloud.json(Cloud.url("/api/auth/register"), { user, pass });
      btn.disabled = false;
      if (!r.ok) return this.fail(r.error || "注册失败");
      Cloud.token = r.token; localStorage.setItem("ft_cloud_token", r.token);
      const users = this.users();
      users[user] = { pass: FT.hash(pass), familyId: null, createdAt: Date.now() };
      this.saveUsers(users);
      this._loginAs(user);
      FT.toast(`欢迎加入，${user}！现在创建或加入一个家庭吧 🏠`);
      this.mode = "family-setup"; this.render();
      Cloud.pull(true);
    } else {
      const btn = FT.$("#authSubmit"); btn.disabled = true;
      const r = await Cloud.json(Cloud.url("/api/auth/login"), { user, pass });
      btn.disabled = false;
      if (!r.ok) return this.fail(r.error || "登录失败");
      Cloud.token = r.token; localStorage.setItem("ft_cloud_token", r.token);
      const users = this.users();
      if (!users[user]) users[user] = { pass: FT.hash(pass), familyId: null, createdAt: Date.now() };
      this._loginAs(user);
      await Cloud.pull(true);
      const fam = this.userFamily();
      if (!fam) { this.mode = "family-setup"; this.render(); }
      else { this.close(); FT.toast(`欢迎回来，${user}！家人们的最新照片已同步 👋`); }
    }
  };

  FT.Auth.logout = function () {
    if (Cloud.on && Cloud.token) {
      Cloud.json(Cloud.url("/api/auth/logout"), { token: Cloud.token }).catch(() => {});
      Cloud.token = ""; localStorage.removeItem("ft_cloud_token");
    }
    localStorage.removeItem(FT.LS.session);
    this.user = null;
    this.render();
    FT.$("#familyPanel").classList.add("hidden");
    FT.refreshAll();
    Cloud.pull(true);
    FT.toast("已退出登录 📦");
  };

  /* ---------- 家庭：创建 / 加入 / 退出（云端权威） ---------- */
  FT.Family.createFromInput = async function () {
    if (!Cloud.on) { const f = origCreate; return f.call(FT.Family); }
    if (!FT.Auth.user) return FT.Auth.open();
    const name = FT.$("#famCreateName").value.trim();
    if (!name || name.length < 2) return FT.toast("请给家庭起个 2 字以上的名字～");
    const r = await Cloud.json(Cloud.url("/api/family/create"), { token: Cloud.token, name });
    if (!r.ok) return FT.toast(r.error || "创建失败");
    const families = this.all();
    families[r.famId] = r.family;
    this.saveAll(families);
    bindLocal(r.famId);
    FT.Auth.close();
    FT.toast(`「${name}」创建成功！邀请码：${r.family.code} 🎉`);
    Cloud.pull(true);
  };
  const origCreate = FT.Family.createFromInput;

  FT.Family.joinFromInput = async function () {
    if (!Cloud.on) { const f = origJoin; return f.call(FT.Family); }
    if (!FT.Auth.user) return FT.Auth.open();
    const code = FT.$("#famJoinCode").value.trim().toUpperCase();
    if (!code) return FT.toast("请输入 6 位家庭邀请码");
    const r = await Cloud.json(Cloud.url("/api/family/join"), { token: Cloud.token, code });
    if (!r.ok) return FT.toast(r.error || "加入失败");
    const families = this.all();
    families[r.famId] = r.family;
    this.saveAll(families);
    bindLocal(r.famId);
    FT.Auth.close();
    FT.toast(`已加入「${r.family.name}」！现在可以共享照片了 🎉`);
    Cloud.pull(true);
  };
  const origJoin = FT.Family.joinFromInput;

  const origLeave = FT.Family.leave.bind(FT.Family);
  FT.Family.leave = async function () {
    if (!Cloud.on || !FT.Auth.user) return origLeave();
    const r = await Cloud.json(Cloud.url("/api/family/leave"), { token: Cloud.token });
    if (!r.ok) return FT.toast(r.error || "操作失败");
    origLeave();
    Cloud.pull(true);
  };

  /* 本地绑定 familyId（云端已处理，不再通知服务器） */
  function bindLocal(famId) {
    const users = FT.Auth.users();
    if (users[FT.Auth.user]) { users[FT.Auth.user].familyId = famId; FT.Auth.saveUsers(users); }
    FT.Auth.render();
    FT.refreshAll();
  }

  /* ---------- 轮询：家人上传 → 自动出现 ---------- */
  function startPolling() {
    setInterval(() => {
      if (document.hidden) return;
      flushPush().then(() => Cloud.pull(false));
    }, 6000);
    window.addEventListener("focus", () => Cloud.pull(false));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) Cloud.pull(false);
    });
  }

  /* ---------- 云模式下跳过本地播种（示例数据由云端下发） ---------- */
  const origSeed = FT.seed;
  FT.seed = async function () {
    if (Cloud.on) return;   // 云端 state 里已带示例数据
    return origSeed();
  };
})();
