/* ============================================================
 * gallery.js — 照片墙 + 随机放映 + 灯箱（图片/视频/Live图）
 * ============================================================ */
FT.Gallery = {
  init() {
    FT.$("#slideshowBtn").addEventListener("click", () => this.startSlideshow());
    FT.$("#slideClose").addEventListener("click", () => this.stopSlideshow());
    FT.$("#slidePrev").addEventListener("click", () => this._slideStep(-1));
    FT.$("#slideNext").addEventListener("click", () => this._slideStep(1));
    FT.$("#slideToggle").addEventListener("click", () => {
      this._playing = !this._playing;
      FT.$("#slideToggle").textContent = this._playing ? "⏸" : "▶";
      if (this._playing) this._schedule();
      else clearTimeout(this._timer);
    });
    document.addEventListener("keydown", (e) => {
      if (FT.$("#lightbox").classList.contains("hidden")) return;
      if (e.key === "Escape") FT.$("#lightbox").classList.add("hidden");
      if (e.key === "ArrowLeft") FT.Lightbox.nav(-1);
      if (e.key === "ArrowRight") FT.Lightbox.nav(1);
    });
    FT.$("#lightboxClose").addEventListener("click", () => FT.$("#lightbox").classList.add("hidden"));
    FT.$("#lightbox").addEventListener("click", e => { if (e.target.id === "lightbox") e.target.classList.add("hidden"); });
    FT.$("#lightboxPrev").addEventListener("click", () => FT.Lightbox.nav(-1));
    FT.$("#lightboxNext").addEventListener("click", () => FT.Lightbox.nav(1));
    this.render();
  },

  /* 所有可见记录中被点亮五角星的媒体 */
  starredItems() {
    const items = [];
    FT.Records.visible().forEach(r => {
      r.media.filter(m => m.starred).forEach(m => items.push({ media: m, record: r }));
    });
    return items;
  },

  render() {
    const items = this.starredItems();
    const grid = FT.$("#galleryGrid");
    FT.$("#galleryCount").textContent = items.length;
    FT.$("#galleryEmpty").classList.toggle("hidden", items.length > 0);
    FT.$("#slideshowBtn").classList.toggle("disabled", !items.length);

    grid.innerHTML = "";
    items.forEach((it, idx) => {
      const fig = document.createElement("figure");
      fig.className = "photo-card";
      fig.innerHTML = `
        ${it.media.type === "video" ? `<video muted playsinline preload="metadata" data-asset="${it.media.asset}"></video>` : `<img data-asset="${it.media.asset}" alt="">`}
        ${it.media.type === "live" ? `<span class="live-badge">LIVE</span>` : ""}
        ${it.media.type === "video" ? `<span class="video-badge">▶</span>` : ""}
        <span class="photo-owner">${FT.esc(FT.ownerName(it.media.owner))}</span>
        <figcaption class="photo-overlay">
          <b>${FT.esc(it.record.city)}</b>
          <span>${FT.esc(it.media.title || "")} · ${FT.esc(FT.dateRange(it.record))}</span>
        </figcaption>`;
      fig.addEventListener("click", () => FT.Lightbox.openList(items, idx));
      grid.appendChild(fig);
    });
    FT.$$("[data-asset]", grid).forEach(async el => {
      const url = await FT.Assets.url(el.dataset.asset);
      if (url) el.src = url;
    });
  },

  /* ---------- 随机放映 ---------- */
  _order: [], _pos: 0, _playing: true, _timer: null,

  startSlideshow() {
    const items = this.starredItems();
    if (!items.length) return FT.toast("还没有点亮五角星的照片，去旅行记录里点亮 ⭐ 吧");
    this._order = items;
    // 洗牌 → 随机滚动播放
    for (let i = this._order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this._order[i], this._order[j]] = [this._order[j], this._order[i]];
    }
    this._pos = 0;
    this._playing = true;
    FT.$("#slideToggle").textContent = "⏸";
    FT.$("#slideshowOverlay").classList.remove("hidden");
    this._slideShow();
  },

  _slideStep(d) {
    const n = this._order.length;
    this._pos = (this._pos + d + n) % n;
    this._slideShow();
    if (this._playing) { clearTimeout(this._timer); this._schedule(); }
  },

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._pos = (this._pos + 1) % this._order.length;
      this._slideShow();
      this._schedule();
    }, 4000);
  },

  async _slideShow() {
    const it = this._order[this._pos];
    if (!it) return;
    const url = await FT.Assets.url(it.media.asset);
    const stage = FT.$("#slideStage");
    stage.innerHTML = "";
    if (it.media.type === "video") {
      const v = document.createElement("video");
      v.src = url; v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
      stage.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.src = url;
      if (it.media.type === "live") {
        const vurl = await FT.Assets.url(it.media.videoAsset);
        const hint = document.createElement("div");
        hint.className = "slide-live-hint";
        hint.textContent = "✨ 长按查看动态";
        const v = document.createElement("video");
        v.src = vurl; v.muted = true; v.loop = true; v.playsInline = true; v.className = "hidden";
        stage.appendChild(img); stage.appendChild(v); stage.appendChild(hint);
        const play = () => { v.classList.remove("hidden"); img.classList.add("dim"); v.play(); hint.classList.add("hidden"); };
        const stop = () => { v.classList.add("hidden"); v.pause(); img.classList.remove("dim"); hint.classList.remove("hidden"); };
        stage.onpointerdown = play;
        stage.onpointerup = stop;
        stage.onpointerleave = stop;
      } else stage.appendChild(img);
    }
    FT.$("#slideCaption").innerHTML =
      `<b>${FT.esc(it.record.city)}</b> · ${FT.esc(it.record.province)}<span>${FT.esc(it.media.title || "")} · ${FT.esc(FT.dateRange(it.record))} · ${FT.esc(FT.ownerName(it.media.owner))} 上传 · ${this._pos + 1}/${this._order.length}</span>`;
  },

  stopSlideshow() {
    clearTimeout(this._timer);
    FT.$("#slideshowOverlay").classList.add("hidden");
    FT.$("#slideStage").innerHTML = "";
  }
};

/* ============================================================
 * Lightbox — 记录详情 / 照片墙共用灯箱
 * 支持 image / video / live（长按播放动态）
 * ============================================================ */
FT.Lightbox = {
  _list: [], _idx: 0, _liveTimer: null,

  openList(items, idx) { this._list = items; this._idx = idx; this._show(); FT.$("#lightbox").classList.remove("hidden"); },
  open(record, mediaIdx) {
    this._list = record.media.map(m => ({ media: m, record }));
    this._idx = mediaIdx;
    this._show();
    FT.$("#lightbox").classList.remove("hidden");
  },
  nav(d) {
    const n = this._list.length;
    if (!n) return;
    this._idx = (this._idx + d + n) % n;
    this._show();
  },

  async _show() {
    const it = this._list[this._idx];
    if (!it) return;
    const m = it.media, r = it.record;
    const box = FT.$("#lightboxFigure");
    box.innerHTML = "";
    const url = await FT.Assets.url(m.asset);

    if (m.type === "video") {
      const v = document.createElement("video");
      v.src = url; v.controls = true; v.autoplay = true; v.playsInline = true;
      box.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.src = url;
      box.appendChild(img);
      if (m.type === "live") {
        const vurl = await FT.Assets.url(m.videoAsset);
        const v = document.createElement("video");
        v.src = vurl; v.muted = true; v.loop = true; v.playsInline = true; v.className = "hidden";
        const hint = document.createElement("div");
        hint.className = "live-hint"; hint.textContent = "✨ 长按播放动态";
        box.appendChild(v); box.appendChild(hint);
        box.onpointerdown = () => { clearTimeout(this._liveTimer); v.classList.remove("hidden"); img.classList.add("dim"); hint.classList.add("hidden"); v.play(); };
        const stop = () => { v.classList.add("hidden"); v.pause(); img.classList.remove("dim"); hint.classList.remove("hidden"); };
        box.onpointerup = stop; box.onpointerleave = () => { this._liveTimer = setTimeout(stop, 80); };
      }
    }
    const cap = document.createElement("figcaption");
    cap.innerHTML = `<b>${FT.esc(r.city)}</b> · ${FT.esc(r.province)}
      <span>${FT.esc(m.title || "")} · ${FT.esc(FT.dateRange(r))} · ${FT.esc(FT.ownerName(m.owner))} 上传 · ${this._idx + 1}/${this._list.length}</span>`;
    box.appendChild(cap);
  }
};
