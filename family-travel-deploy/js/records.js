/* ============================================================
 * records.js — 旅行记录
 * 省份/地级市联动 → 创建记录（可选封面）→ 详情编辑
 * （日期精确到年月日 / 文字描述 / 图片+视频+Live图上传 /
 *   右上角五角星最爱 / 自定义景点 tag）
 * ============================================================ */
FT.Records = {
  /* ---------- 数据 ---------- */
  all() { return FT.store.get(FT.LS.records, []); },
  save(list) { FT.store.set(FT.LS.records, list); },
  visible() {
    return this.all()
      .filter(r => FT.canView(r.owner))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },
  get(id) { return this.all().find(r => r.id === id); },
  put(rec) { const l = this.all(); const i = l.findIndex(r => r.id === rec.id); if (i >= 0) l[i] = rec; else l.push(rec); this.save(l); },
  remove(id) {
    const rec = this.get(id);
    if (rec) {
      FT.Assets.del(rec.cover);
      rec.media.forEach(m => { FT.Assets.del(m.asset); if (m.videoAsset) FT.Assets.del(m.videoAsset); });
    }
    this.save(this.all().filter(r => r.id !== id));
  },

  /* ---------- 初始化 ---------- */
  init() {
    // 省市联动
    const provSel = FT.$("#provSel"), citySel = FT.$("#citySel");
    Object.keys(CHINA).forEach(p => {
      const o = document.createElement("option");
      o.value = o.textContent = p;
      provSel.appendChild(o);
    });
    provSel.addEventListener("change", () => {
      citySel.innerHTML = '<option value="">选择地级市</option>';
      (CHINA[provSel.value] || []).forEach(c => {
        const o = document.createElement("option");
        o.value = o.textContent = c;
        citySel.appendChild(o);
      });
      citySel.disabled = !provSel.value;
    });

    // 创建记录
    FT.$("#createRecBtn").addEventListener("click", () => this.openCreate());

    // 创建弹窗
    FT.$("#recCreateClose").addEventListener("click", () => FT.$("#recCreateModal").classList.add("hidden"));
    FT.$("#recCreateModal").addEventListener("click", e => { if (e.target.id === "recCreateModal") e.target.classList.add("hidden"); });
    FT.$("#recCoverInput").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      this._pendingCoverBlob = await FT.Assets.compressImage(f);
      const url = URL.createObjectURL(this._pendingCoverBlob);
      const prev = FT.$("#recCoverPreview");
      prev.src = url;
      prev.classList.remove("hidden");
    });
    FT.$("#recCreateSubmit").addEventListener("click", () => this.createRecord());

    // 详情弹窗
    FT.$("#recDetailClose").addEventListener("click", () => FT.$("#recDetailModal").classList.add("hidden"));
    FT.$("#recDetailModal").addEventListener("click", e => { if (e.target.id === "recDetailModal") e.target.classList.add("hidden"); });

    this.render();
  },

  /* ---------- 创建 ---------- */
  openCreate() {
    if (!FT.Auth.user) return FT.Auth.open();
    const prov = FT.$("#provSel").value, city = FT.$("#citySel").value;
    if (!prov || !city) return FT.toast("请先选择省份和地级市");
    FT.$("#recCreateTitle").textContent = `创建旅行记录 · ${city}`;
    FT.$("#recCreateSub").textContent = `${prov} · ${city}（封面可以现在选，也可以跳过）`;
    FT.$("#recCoverPreview").classList.add("hidden");
    FT.$("#recCoverInput").value = "";
    this._pendingCoverBlob = null;
    FT.$("#recCreateModal").classList.remove("hidden");
  },

  async createRecord() {
    const prov = FT.$("#provSel").value, city = FT.$("#citySel").value;
    if (!prov || !city) return FT.toast("请先选择省份和地级市");

    let coverAsset = null;
    if (this._pendingCoverBlob) {
      coverAsset = FT.uid("ast");
      await FT.Assets.put(coverAsset, this._pendingCoverBlob);
    }
    const rec = {
      id: FT.uid("rec"), province: prov, city,
      cover: coverAsset,
      dateStart: new Date().toISOString().slice(0, 10),
      dateEnd: new Date().toISOString().slice(0, 10),
      desc: "",
      tags: [],
      media: [],
      owner: FT.Auth.user,
      createdAt: Date.now()
    };
    this.put(rec);
    FT.$("#recCreateModal").classList.add("hidden");
    FT.$("#provSel").value = ""; FT.$("#citySel").value = ""; FT.$("#citySel").disabled = true;
    FT.$("#citySel").innerHTML = '<option value="">选择地级市</option>';
    this.render();
    FT.toast(`${city} 的旅行记录已创建，点开卡片补充细节吧 ✈️`);
  },

  /* ---------- 记录卡片 ---------- */
  render() {
    const list = this.visible();
    const grid = FT.$("#recordGrid");
    FT.$("#recordEmpty").classList.toggle("hidden", list.length > 0);

    grid.innerHTML = list.map(r => {
      const photoCount = r.media.filter(m => m.type === "image" || m.type === "live").length;
      const videoCount = r.media.filter(m => m.type === "video" || m.type === "live").length;
      const stars = r.media.filter(m => m.starred).length;
      return `
      <article class="record-card card" data-id="${r.id}">
        <div class="record-cover" data-cover="${r.cover || ""}">
          <img alt="" ${r.cover ? `data-asset="${r.cover}"` : ""}>
          <div class="record-cover-ph ${r.cover ? "hidden" : ""}">📍<br>${FT.esc(r.city)}</div>
          <span class="record-prov-chip">${FT.esc(r.province)}</span>
        </div>
        <div class="record-body">
          <h3>${FT.esc(r.city)}</h3>
          <p class="record-date">🗓 ${FT.esc(FT.dateRange(r))}</p>
          <p class="record-desc">${FT.esc((r.desc || "点击补充旅行描述…").slice(0, 40))}${(r.desc || "").length > 40 ? "…" : ""}</p>
          <div class="record-tags">${(r.tags || []).slice(0, 4).map(t => `<span>${FT.esc(t)}</span>`).join("")}</div>
          <div class="record-foot">
            <span class="record-counts">📷 ${photoCount} · 🎬 ${videoCount}${stars ? ` · ⭐ ${stars}` : ""}</span>
            <span class="record-owner">${FT.esc(FT.ownerName(r.owner))}</span>
          </div>
        </div>
      </article>`;
    }).join("");

    this._hydrate(grid);

    FT.$$(".record-card", grid).forEach(card =>
      card.addEventListener("click", () => this.openDetail(card.dataset.id)));
  },

  /* 异步填充图片 src（IndexedDB objectURL） */
  async _hydrate(scope) {
    const imgs = FT.$$("img[data-asset]", scope);
    for (const img of imgs) {
      const url = await FT.Assets.url(img.dataset.asset);
      if (url) { img.src = url; img.closest(".record-cover")?.classList.add("has-img"); }
      else img.closest(".record-cover")?.classList.add("no-img");
    }
  },

  /* ---------- 详情编辑 ---------- */
  _current: null,

  /* 统一可编辑判定：家庭成员都可编辑彼此的记录（含示例模板） */
  _editable(rec) {
    if (!rec || !FT.Auth.user) return false;
    if (rec.owner === FT.Auth.user || rec.owner === "system") return true;
    const fam = FT.Auth.userFamily();
    return !!(fam && fam.members.includes(rec.owner));
  },

  openDetail(id) {
    const rec = this.get(id);
    if (!rec || !FT.canView(rec.owner)) return;
    this._current = rec;
    this._renderDetail(rec, this._editable(rec));
    FT.$("#recDetailModal").classList.remove("hidden");
  },

  _renderDetail(rec, editable) {
    FT.$("#recDetailTitle").innerHTML = `📍 ${FT.esc(rec.city)} <small>${FT.esc(rec.province)}</small>`;
    FT.$("#recDetailMeta").innerHTML = `记录者：<b>${FT.esc(FT.ownerName(rec.owner))}</b> · 创建于 ${FT.fmtDate(rec.createdAt)}`;
    FT.$("#recDetailDel").classList.toggle("hidden", !editable);
    FT.$("#recDetailMediaBar").classList.toggle("hidden", !editable);

    // 封面（可后补 / 可更换）
    FT.$("#recCoverUploadBtn").disabled = !editable;
    FT.$("#recCoverName").textContent = rec.cover ? "已设置封面，可随时更换" : "还没有封面，可以现在选一张";
    FT.$("#recCoverName").classList.toggle("no-cover", !rec.cover);

    // 日期区间
    FT.$("#recDateStartInput").value = rec.dateStart || rec.date || "";
    FT.$("#recDateEndInput").value = rec.dateEnd || rec.dateStart || rec.date || "";
    FT.$("#recDateStartInput").disabled = !editable;
    FT.$("#recDateEndInput").disabled = !editable;

    // 描述
    const ta = FT.$("#recDescInput");
    ta.value = rec.desc || "";
    ta.disabled = !editable;
    ta.placeholder = editable ? "写写这趟旅行的故事：吃了什么、看到了什么、谁笑得最大声…" : "（家庭成员登录后即可编辑）";

    // 标签
    this._renderTags(rec, editable);

    // 媒体
    this._renderMedia(rec, editable);
  },

  /* 只渲染 tag 区块（回车添加后调用，不动其他区域、不丢焦点） */
  _renderTags(rec, editable) {
    FT.$("#recTagList").innerHTML = (rec.tags || []).map((t, i) => `
      <span class="tag-chip">${FT.esc(t)}${editable ? `<i data-tag="${i}">✕</i>` : ""}</span>`).join("");
    FT.$("#recTagAddWrap").classList.toggle("hidden", !editable);
    FT.$$(".tag-chip i", FT.$("#recTagList")).forEach(x =>
      x.addEventListener("click", () => {
        rec.tags.splice(+x.dataset.tag, 1);
        this.put(rec); this._renderTags(rec, editable); this.render();
      }));
  },

  _renderMedia(rec, editable) {
    const box = FT.$("#recMediaGrid");
    box.innerHTML = rec.media.length ? "" : `<p class="media-empty">${editable ? "还没有照片，用上方按钮上传 📷" : "还没有照片"}</p>`;
    rec.media.forEach((m, idx) => {
      const fig = document.createElement("figure");
      fig.className = "media-item";
      fig.innerHTML = `
        ${m.type === "video" ? `<video data-asset="${m.asset}" muted playsinline preload="metadata"></video>` : `<img data-asset="${m.asset}" alt="">`}
        ${m.type === "live" ? `<span class="live-badge">LIVE</span>` : ""}
        ${m.type === "video" ? `<span class="video-badge">▶ 视频</span>` : ""}
        <button class="media-star ${m.starred ? "on" : ""}" title="${m.starred ? "取消最爱" : "点亮最爱"}"></button>
        ${editable ? `<button class="media-cover" title="把这张设为封面">🖼</button>` : ""}
        ${editable ? `<button class="media-del" title="删除">🗑</button>` : ""}
        <figcaption>${FT.esc(m.title || "")}${m.type === "live" ? " <i>(长按查看动态)</i>" : ""}</figcaption>`;
      fig.querySelector(".media-star").addEventListener("click", () => {
        m.starred = !m.starred;
        this.put(rec);
        this._renderMedia(rec, editable);
        FT.toast(m.starred ? "已点亮五角星 ⭐ 会出现在照片墙" : "已取消最爱");
        this.render();
      });
      fig.querySelector(".media-cover")?.addEventListener("click", () => {
        rec.cover = m.asset;
        this.put(rec);
        this.render();
        FT.toast("已将这张照片设为封面 🖼");
      });
      fig.querySelector(".media-del")?.addEventListener("click", () => {
        if (!confirm("删除这张照片/视频？")) return;
        FT.Assets.del(m.asset);
        if (m.videoAsset) FT.Assets.del(m.videoAsset);
        rec.media.splice(idx, 1);
        this.put(rec); this._renderMedia(rec, editable); this.render();
      });
      fig.addEventListener("click", (e) => {
        if (e.target.tagName === "BUTTON" || e.target.tagName === "I") return;
        FT.Lightbox.open(rec, idx);
      });
      box.appendChild(fig);
    });
    // 异步填充 src
    FT.$$("img[data-asset],video[data-asset]", box).forEach(async (el) => {
      const url = await FT.Assets.url(el.dataset.asset);
      if (url) el.src = url;
    });
  },

  /* ---------- 详情内编辑事件（init 时绑定一次） ---------- */
  bindDetailEvents() {
    /* ---- 封面：随时后补 / 更换 ---- */
    FT.$("#recCoverUploadBtn").addEventListener("click", () => {
      if (!this._current || !this._editable(this._current)) return FT.toast("登录家庭成员可设置封面");
      FT.$("#recCoverFileInput").click();
    });
    FT.$("#recCoverFileInput").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f || !this._current) return;
      const blob = await FT.Assets.compressImage(f);
      const id = FT.uid("ast");
      await FT.Assets.put(id, blob);
      this._current.cover = id;
      this.put(this._current);
      this._renderDetail(this._current, this._editable(this._current));
      this.render();
      FT.toast("封面已更新 🖼");
    });
    const saveDates = () => {
      if (!this._current) return;
      let s = FT.$("#recDateStartInput").value, e = FT.$("#recDateEndInput").value;
      if (!s) return FT.toast("请先选择开始日期");
      if (e && e < s) [s, e] = [e, s]; // 自动纠正顺序
      this._current.dateStart = s;
      this._current.dateEnd = e || s;
      FT.$("#recDateStartInput").value = this._current.dateStart;
      FT.$("#recDateEndInput").value = this._current.dateEnd;
      this.put(this._current);
      FT.toast("日期已保存 🗓");
      this.render(); FT.Timeline?.render();
    };
    FT.$("#recDateStartInput").addEventListener("change", saveDates);
    FT.$("#recDateEndInput").addEventListener("change", saveDates);
    FT.$("#recDescInput").addEventListener("blur", () => {
      if (!this._current) return;
      this._current.desc = FT.$("#recDescInput").value;
      this.put(this._current);
      FT.toast("描述已保存 ✍️"); this.render(); FT.Timeline?.render();
    });
    FT.$("#recTagInput").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = e.target.value.trim().slice(0, 12);
      if (!v) return;
      if (!this._current) return;
      if (!this._current.tags) this._current.tags = [];
      if (this._current.tags.includes(v)) { FT.toast("这个 tag 已经有了"); return; }
      this._current.tags.push(v);
      e.target.value = "";
      this.put(this._current);
      // 只刷新 tag 区块，输入框保持可见 + 焦点，可继续连续添加
      this._renderTags(this._current, this._editable(this._current));
      this.render();
      FT.$("#recTagInput").focus();
      FT.toast(`已添加「${v}」，可继续输入下一个 🏷`);
    });

    FT.$("#recDetailDel").addEventListener("click", () => {
      if (!confirm("删除整条旅行记录（含所有照片）？此操作不可恢复。")) return;
      const id = this._current.id;
      this.remove(id);
      FT.$("#recDetailModal").classList.add("hidden");
      FT.toast("记录已删除");
      this.render(); FT.Gallery.render(); FT.Timeline?.render();
    });

    /* ---- 媒体上传 ---- */
    FT.$("#recPhotoPickBtn").addEventListener("click", () => FT.$("#recPhotoInput").click());
    FT.$("#recVideoPickBtn").addEventListener("click", () => FT.$("#recVideoInput").click());
    FT.$("#recLivePickBtn").addEventListener("click", () => FT.$("#livePhotoPick").click());
    FT.$("#recPhotoInput").addEventListener("change", (e) => this.uploadMedia(e.target.files, "image"));
    FT.$("#recVideoInput").addEventListener("change", (e) => this.uploadMedia(e.target.files, "video"));
    // Live 图：先选照片，再选配套短视频
    FT.$("#livePhotoPick").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      this._liveImgBlob = await FT.Assets.compressImage(f);
      FT.$("#livePhotoPick").value = "";
      FT.$("#liveVideoPick").click();
    });
    FT.$("#liveVideoPick").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (f) await this.uploadLive(this._liveImgBlob, f);
      this._liveImgBlob = null;
      FT.$("#liveVideoPick").value = "";
    });
  },

  async uploadMedia(files, type) {
    const rec = this._current;
    if (!rec || !this._editable(rec)) return FT.toast("请先登录，并打开自己的（或示例）记录");
    const arr = Array.from(files).filter(f =>
      type === "video" ? f.type.startsWith("video/") : f.type.startsWith("image/"));
    if (!arr.length) return FT.toast(type === "video" ? "请选择视频文件" : "请选择图片文件");
    if (type === "video" && arr.some(f => f.size > 80 * 1024 * 1024))
      return FT.toast("单个视频请小于 80MB");

    FT.$("#recUploadHint").textContent = `上传中 0/${arr.length}…`;
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      const blob = type === "image" ? await FT.Assets.compressImage(f) : f;
      const assetId = FT.uid("ast");
      await FT.Assets.put(assetId, blob);
      rec.media.push({
        id: FT.uid("m"), type,
        asset: assetId,
        title: f.name.replace(/\.[^.]+$/, "").slice(0, 16) || (type === "video" ? "视频" : "照片"),
        starred: false,
        owner: FT.Auth.user,
        createdAt: Date.now()
      });
      FT.$("#recUploadHint").textContent = `上传中 ${i + 1}/${arr.length}…`;
    }
    this.put(rec);
    this._renderDetail(rec, this._editable(rec));
    this.render();
    FT.$("#recUploadHint").textContent = "";
    FT.$("#recPhotoInput").value = "";
    FT.$("#recVideoInput").value = "";
    FT.toast(`成功上传 ${arr.length} 个${type === "video" ? "视频" : "照片"} 🎉`);
  },

  async uploadLive(imgBlob, videoFile) {
    const rec = this._current;
    if (!rec || !this._editable(rec)) return FT.toast("请先登录，并打开自己的（或示例）记录");
    if (!imgBlob) return FT.toast("Live 图需要先选择一张照片");
    if (!videoFile.type.startsWith("video/")) return FT.toast("Live 图需要一段配套短视频");
    if (videoFile.size > 80 * 1024 * 1024) return FT.toast("配套视频请小于 80MB");

    FT.$("#recUploadHint").textContent = "Live 图上传中…";
    const imgId = FT.uid("ast"), vidId = FT.uid("ast");
    await FT.Assets.put(imgId, imgBlob);
    await FT.Assets.put(vidId, videoFile);
    rec.media.push({
      id: FT.uid("m"), type: "live",
      asset: imgId, videoAsset: vidId,
      title: "Live 图",
      starred: false,
      owner: FT.Auth.user,
      createdAt: Date.now()
    });
    this.put(rec);
    this._renderDetail(rec, this._editable(rec));
    this.render();
    FT.$("#recUploadHint").textContent = "";
    FT.toast("Live 图上传成功 ✨ 在灯箱里长按可播放动态");
  }
};
