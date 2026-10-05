/* ============================================================
 * app.js — 首页温馨小设计 + 启动
 * ============================================================ */
FT.Home = {
  _quoteTimer: null,
  _quotes: [
    "世界很大，幸好我们可以一起去看。❤️",
    "最好的风景，是回头时你们都在。",
    "旅行的意义不是目的地，而是副驾驶座上的笑声。",
    "家在哪，哪就是出发的地方。",
    "别等风景老了才出发，别等孩子大了才旅行。",
    "我们不是在赶路，我们是在收集回忆。",
    "每一次出发，都是给生活换一口新鲜的空气。",
    "地图上的每一条线，都是我们画下的全家福。"
  ],

  init() {
    this.render();
    FT.$("#memoryRefresh").addEventListener("click", () => this.renderMemory(true));
  },

  render() {
    this.renderStats();
    this.renderGoal();
    this.renderFamilyCard();
    this.renderMemory(false);
    this.renderQuote();
  },

  /* ---------- 动态统计 ---------- */
  renderStats() {
    const recs = FT.Records.visible();
    const provs = new Set(recs.map(r => r.province));
    let photos = 0, stars = 0, videos = 0;
    recs.forEach(r => r.media.forEach(m => {
      if (m.type !== "video") photos++;
      if (m.type !== "image") videos++;
      if (m.starred) stars++;
    }));
    FT.$("#statRecords").textContent = recs.length;
    FT.$("#statProvinces").textContent = provs.size;
    FT.$("#statPhotos").textContent = photos;
    FT.$("#statStars").textContent = stars;
  },

  /* ---------- 旅行小目标 ---------- */
  renderGoal() {
    const recs = FT.Records.visible();
    const visited = new Set(recs.map(r => r.province));
    const pct = Math.min(100, Math.round(visited.size / PROVINCE_TOTAL * 100));
    FT.$("#goalFill").style.width = pct + "%";
    FT.$("#goalText").textContent = `已打卡 ${visited.size} / ${PROVINCE_TOTAL} 个省级行政区`;
    const remain = Object.keys(CHINA).filter(p => !visited.has(p));
    FT.$("#goalRemain").textContent = remain.length
      ? `下一个目标：${remain[Math.floor(Math.random() * Math.min(remain.length, 6))]}？`
      : "🎉 全部打卡完成，太了不起了！";
  },

  /* ---------- 家庭卡片 ---------- */
  renderFamilyCard() {
    const box = FT.$("#familyCard");
    const fam = FT.Auth.user ? FT.Auth.userFamily() : null;
    if (fam) {
      box.innerHTML = `
        <h4>🏠 ${FT.esc(fam.name)}</h4>
        <div class="family-avatars">
          ${fam.members.map(m => `
            <div class="family-member">
              <span class="avatar" style="background:hsl(${[...m].reduce((s, c) => s + c.charCodeAt(0), 0) % 360},60%,55%)">${FT.esc(m.slice(0, 1))}</span>
              <i>${FT.esc(m)}</i>
            </div>`).join("")}
        </div>
        <p class="family-tip">家人上传的照片会自动共享，点击顶部家庭名可查看邀请码 ✉️</p>`;
    } else {
      box.innerHTML = `
        <h4>🏠 我们的家</h4>
        <p class="family-tip">登录并创建家庭后，家人凭邀请码加入，就能共享所有旅行照片啦。</p>
        <button class="btn btn-primary btn-sm" id="familyCta">创建 / 加入家庭</button>`;
      FT.$("#familyCta").addEventListener("click", () => FT.Auth.user ? FT.Family.renderPanel() : FT.Auth.open());
    }
  },

  /* ---------- 回忆碎片 ---------- */
  renderMemory(refresh) {
    const recs = FT.Records.visible().filter(r => r.media.length);
    const box = FT.$("#memoryCard");
    if (!recs.length) {
      box.innerHTML = `<h4>🎲 回忆碎片</h4><p class="family-tip">创建第一条旅行记录后，这里会随机掉落一段回忆。</p>`;
      return;
    }
    let pick;
    if (refresh || !this._memoryId || !(pick = recs.find(r => r.id === this._memoryId))) {
      pick = recs[Math.floor(Math.random() * recs.length)];
      this._memoryId = pick.id;
    }
    const m = pick.media[pick.media.length - 1];
    box.innerHTML = `
      <h4>🎲 回忆碎片</h4>
      <div class="memory-row">
        <img data-asset="${m.asset}" alt="">
        <div class="memory-text">
          <b>${FT.esc(pick.city)} · ${FT.esc(FT.dateRange(pick))}</b>
          <p>${FT.esc((pick.desc || "这段旅程还没有描述…").slice(0, 46))}</p>
        </div>
      </div>
      <button class="memory-refresh" id="memoryRefresh" title="换一段回忆">🎲 换一段</button>`;
    (async () => { const img = box.querySelector("img"); img.src = await FT.Assets.url(m.asset) || ""; })();
    FT.$("#memoryRefresh").addEventListener("click", () => this.renderMemory(true));
    this.renderStats(); this.renderGoal();
  },

  /* ---------- 每日一句 ---------- */
  renderQuote() {
    const el = FT.$("#quoteText");
    clearInterval(this._quoteTimer);
    const next = () => {
      el.style.opacity = 0;
      setTimeout(() => {
        el.textContent = this._quotes[Math.floor(Math.random() * this._quotes.length)];
        el.style.opacity = 1;
      }, 400);
    };
    if (!el.textContent) el.textContent = this._quotes[0];
    this._quoteTimer = setInterval(next, 6000);
  }
};


/* ============================================================
 * Timeline — 旅程时间线
 * 电脑：从左往右横向排布（可横向滚动）；手机：从上往下排布
 * ============================================================ */
FT.Timeline = {
  render() {
    const box = FT.$("#timelineBox");
    if (!box) return;
    const recs = FT.Records.visible()
      .slice()
      .sort((a, b) => (a.dateStart || "9999").localeCompare(b.dateStart || "9999"));
    if (!recs.length) {
      box.innerHTML = `<p class="route-empty">还没有记录，创建旅行记录后这里会按时间排列 🗓</p>`;
      return;
    }
    box.innerHTML = recs.map((r, i) => `
      <div class="tl-node" data-id="${r.id}" style="--i:${i}">
        <span class="tl-dot"></span>
        <span class="tl-date">🗓 ${FT.esc(FT.dateRange(r))}</span>
        <div class="tl-card card">
          <b>${FT.esc(r.city)}</b>
          <i>${FT.esc(r.province)}</i>
          <p>${FT.esc((r.desc || "点击补充旅行描述…").slice(0, 52))}</p>
          <span class="tl-owner">✍ ${FT.esc(FT.ownerName(r.owner))}${r.media.length ? ` · 📷 ${r.media.length}` : ""}</span>
        </div>
      </div>`).join("");
    FT.$$(".tl-node", box).forEach(n => n.addEventListener("click", () => FT.Records.openDetail(n.dataset.id)));
  }
};

/* ============================================================
 * 启动
 * ============================================================ */
document.addEventListener("DOMContentLoaded", async () => {
  await FT.Assets.open();
  await window.FTCloud?.ready;   // 探测云端；若可用会先完成首轮数据同步
  FT.Auth.init();
  FT.Family.initPanel();
  await FT.seed();
  FT.Map.init();
  FT.Records.init();
  FT.Records.bindDetailEvents();
  FT.Gallery.init();
  FT.Home.init();
  FT.Timeline.render();

  // 导航滚动效果
  window.addEventListener("scroll", () => FT.$("#navbar").classList.toggle("scrolled", scrollY > 10));
  FT.$("#navBurger").addEventListener("click", () => FT.$("#navLinks").classList.toggle("open"));
  FT.$$("#navLinks a").forEach(a => a.addEventListener("click", () => FT.$("#navLinks").classList.remove("open")));

  // 温馨彩带装饰（浮动小图标）
  const floaters = ["🧳", "🗺️", "❤️", "✈️", "📸", "🐚", "🌵", "⛱️"];
  const wrap = FT.$("#floaters");
  floaters.forEach((f, i) => {
    const s = document.createElement("span");
    s.textContent = f;
    s.style.left = (6 + i * 11.5) + "%";
    s.style.top = (10 + ((i * 37) % 70)) + "%";
    s.style.animationDelay = (i * 0.9) + "s";
    s.style.fontSize = (18 + (i % 4) * 7) + "px";
    wrap.appendChild(s);
  });
});
