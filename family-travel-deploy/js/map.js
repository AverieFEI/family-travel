/* ============================================================
 * map.js — 中国地图（精确到市）
 * 添加路线：① 直接点击地图连线 ② 手动选择出发/到达省市
 * 点击省份可下钻查看该省地级市；返回按钮回到全国
 * ============================================================ */
FT.Map = {
  chart: null,
  adding: false,        // 是否处于“添加路线”模式
  pendingFrom: null,    // 已选起点
  _lastRegion: null,    // 最近悬停/点击的行政区名（省或市）

  provAdcodes: {},      // 省份名 -> adcode
  geoCache: {},         // adcode -> geojson
  view: { adcode: "100000", name: "全国" }, // 当前视图

  /* ---------- 数据 ---------- */
  allRoutes() { return FT.store.get(FT.LS.routes, []); },
  visibleRoutes() { return this.allRoutes().filter(r => FT.canView(r.owner)); },
  canDelete(r) { return FT.Auth.user && (r.owner === FT.Auth.user || r.owner === "system"); },

  /* ---------- 初始化 ---------- */
  init() {
    FT.$("#routeToggleBtn").addEventListener("click", () => this.toggleAdd());
    FT.$("#routeClearBtn").addEventListener("click", () => {
      if (!FT.Auth.user) return FT.Auth.open();
      const mine = this.allRoutes().filter(r => r.owner === FT.Auth.user);
      if (!mine.length) return FT.toast("你还没有添加过路线");
      if (!confirm(`确定清空自己添加的 ${mine.length} 条路线吗？`)) return;
      FT.store.set(FT.LS.routes, this.allRoutes().filter(r => r.owner !== FT.Auth.user));
      this.render();
      FT.toast("已清空我的路线 🧹");
    });
    FT.$("#mapBackBtn").addEventListener("click", () => this.showNational());

    // 手动选择省市添加路线
    const selects = [
      ["#mrFromProv", "#mrFromCity"], ["#mrToProv", "#mrToCity"]
    ];
    selects.forEach(([ps, cs]) => {
      const provSel = FT.$(ps), citySel = FT.$(cs);
      Object.keys(CHINA).forEach(p => {
        const o = document.createElement("option");
        o.value = o.textContent = p;
        provSel.appendChild(o);
      });
      provSel.addEventListener("change", () => {
        citySel.innerHTML = '<option value="">城市</option>';
        (CHINA[provSel.value] || []).forEach(c => {
          const o = document.createElement("option");
          o.value = o.textContent = c;
          citySel.appendChild(o);
        });
        citySel.disabled = !provSel.value;
      });
    });
    FT.$("#mrAddBtn").addEventListener("click", () => this.addManualRoute());

    /* 中国地图边界：优先加载网站内置资源（离线/弱网也能显示），失败再走 CDN */
    const geoSources = [
      "js/vendor/china-geo.json",
      "https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json",
    ];
    const tryLoadGeo = (i) => {
      if (i >= geoSources.length) {
        FT.$("#chinaMap").style.display = "none";
        FT.$("#mapFallback").classList.remove("hidden");
        return;
      }
      fetch(geoSources[i])
        .then(r => { if (!r.ok) throw new Error("geo " + r.status); return r.json(); })
        .then(geo => {
          if (!window.echarts) throw new Error("echarts 未加载");
          echarts.registerMap("china-100000", geo);
          this.geoCache["100000"] = geo;
          geo.features.forEach(f => {
            if (f.properties && f.properties.adcode && f.properties.name)
              this.provAdcodes[f.properties.name] = String(f.properties.adcode);
          });
          FT.$("#mapFallback").classList.add("hidden");
          this.build();
        })
        .catch(() => tryLoadGeo(i + 1));
    };
    tryLoadGeo(0);
  },

  build() {
    this.chart = echarts.init(FT.$("#chinaMap"));

    this.chart.on("mouseover", (params) => {
      if (params.componentType === "geo") this._lastRegion = params.name;
    });

    this.chart.on("click", (params) => {
      if (params.componentType !== "geo") return;
      const region = params.name;
      this._lastRegion = region;

      if (this.adding) return;                 // 添加路线模式下点击 = 选点
      if (region === this.view.name) return;   // 已在该省
      const adcode = this.provAdcodes[region];
      if (adcode) this.drillDown(adcode, region);
      else if (this.view.adcode !== "100000") this.showNational(); // 在省内点空白/边界回全国
    });

    // zrender 级点击：像素坐标 -> 经纬度
    this.chart.getZr().on("click", (e) => {
      if (!this.adding) return;
      const coord = this.chart.convertFromPixel("geo", [e.offsetX, e.offsetY]);
      if (!coord || !isFinite(coord[0]) || !isFinite(coord[1])) return;
      this.handlePoint(coord, this._lastRegion);
    });

    window.addEventListener("resize", () => this.chart && this.chart.resize());
    this.render();
  },

  /* ---------- 下钻 / 返回 ---------- */
  async fetchGeo(adcode) {
    if (this.geoCache[adcode]) return this.geoCache[adcode];
    /* 1) localStorage 缓存（首次成功下载后，之后离线/弱网也能下钻） */
    try {
      const cached = localStorage.getItem("ft_geo_" + adcode);
      if (cached) {
        const geo = JSON.parse(cached);
        this.geoCache[adcode] = geo;
        return geo;
      }
    } catch (e) { /* 缓存损坏则忽略 */ }
    /* 2) 本地内置数据 → 在线 CDN 兜底（双保险，弱网也能下钻） */
    const sources = [
      `js/vendor/geo/${adcode}_full.json`,
      `js/vendor/${adcode}_full.json`,
      `https://geo.datav.aliyun.com/areas_v3/bound/${adcode}_full.json`
    ];
    let geo = null;
    for (const src of sources) {
      try {
        geo = await fetch(src).then(r => { if (!r.ok) throw new Error("geo " + r.status); return r.json(); });
        break;
      } catch (e) { /* 该源失败，尝试下一个 */ }
    }
    if (!geo) throw new Error("地图数据不可用");
    this.geoCache[adcode] = geo;
    try { localStorage.setItem("ft_geo_" + adcode, JSON.stringify(geo)); } catch (e) { /* 存储满则跳过 */ }
    return geo;
  },

  async drillDown(adcode, name) {
    try {
      const geo = await this.fetchGeo(adcode);
      echarts.registerMap("china-" + adcode, geo);
      this.view = { adcode, name };
      FT.$("#mapBackBtn").classList.remove("hidden");
      FT.$("#mapLocLabel").textContent = "📍 " + name;
      FT.toast(`已进入 ${name}，地图精确到地级市`);
      this.render();
    } catch {
      FT.toast("该地区地图加载失败，请稍后再试");
    }
  },

  showNational() {
    this.view = { adcode: "100000", name: "全国" };
    FT.$("#mapBackBtn").classList.add("hidden");
    FT.$("#mapLocLabel").textContent = "";
    this.render();
  },

  /* ---------- 点击地图添加 ---------- */
  toggleAdd(force) {
    if (!FT.Auth.user) return FT.Auth.open();
    this.adding = force !== undefined ? force : !this.adding;
    this.pendingFrom = null;
    const btn = FT.$("#routeToggleBtn");
    btn.classList.toggle("active", this.adding);
    FT.$("#routeHint").textContent = this.adding
      ? "点击地图选择起点 📍（点击省份可先下钻到市再选点）"
      : "点击「添加路线」在地图上连线，或使用下方「手动选择省市」";
    btn.querySelector("span").textContent = this.adding ? "✓ 再点一次完成" : "＋ 添加路线";
    if (this.adding) FT.toast("先点地图选起点，再点终点；也可以在下方手动选择省市");
  },

  handlePoint(coord, region) {
    const point = { coord: [Number(coord[0].toFixed(2)), Number(coord[1].toFixed(2))], name: region || "地图上的点" };
    if (!this.pendingFrom) {
      this.pendingFrom = point;
      FT.$("#routeHint").textContent = `起点已选：${point.name}，再点击地图选择终点 🏁`;
      this.render();
      FT.toast(`起点：${point.name}，请点击终点`);
    } else {
      this._pushRoute(this.pendingFrom, point);
      this.pendingFrom = null;
      FT.$("#routeHint").textContent = "点击地图选择起点 📍";
      this.render();
    }
  },

  _pushRoute(from, to) {
    const routes = this.allRoutes();
    routes.push({ id: FT.uid("rt"), from, to, owner: FT.Auth.user, createdAt: Date.now() });
    FT.store.set(FT.LS.routes, routes);
    FT.toast(`路线已添加：${from.name} → ${to.name} ✈️`);
  },

  /* ---------- 手动选择省市添加 ---------- */
  async resolveCity(prov, city) {
    const adcode = this.provAdcodes[prov];
    if (!adcode) return null;
    const geo = await this.fetchGeo(adcode);
    const f = geo.features.find(f => {
      const n = f.properties.name || "";
      return n === city || n.replace(/市$/, "") === city.replace(/市$/, "") ||
             (city.startsWith(n) || n.startsWith(city));
    });
    if (f && f.properties.center) return f.properties.center;
    if (f) { // 兜底：多边形质心
      const g = f.geometry;
      let pts = [];
      const collect = (poly) => poly.forEach(ring => pts = pts.concat(ring));
      if (g.type === "Polygon") collect([g.coordinates[0]]);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => collect([p[0]]));
      if (pts.length) {
        const n = pts.length;
        return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
      }
    }
    /* 兜底 2：直辖市（北京/上海/天津/重庆）——市级数据里没有同名区县，直接用市政府坐标 */
    const MUNI_COORD = {
      "北京市": [116.407, 39.904], "天津市": [117.200, 39.084],
      "上海市": [121.474, 31.230], "重庆市": [106.551, 29.563]
    };
    const bare = city.replace(/市$/, "");
    if (MUNI_COORD[city]) return MUNI_COORD[city];
    if (MUNI_COORD[bare + "市"]) return MUNI_COORD[bare + "市"];
    /* 兜底 3：仍找不到时，取全省所有区县的几何中心，保证路线一定能加上 */
    let all = [];
    geo.features.forEach(ft => {
      const g = ft.geometry || {};
      const collect = (poly) => poly.forEach(ring => all = all.concat(ring));
      if (g.type === "Polygon") collect([g.coordinates[0]]);
      else if (g.type === "MultiPolygon") g.coordinates.forEach(p => collect([p[0]]));
    });
    if (all.length) {
      const n = all.length;
      return [all.reduce((s, p) => s + p[0], 0) / n, all.reduce((s, p) => s + p[1], 0) / n];
    }
    return CITY_COORD[city] || null;
  },

  async addManualRoute() {
    if (!FT.Auth.user) return FT.Auth.open();
    const fp = FT.$("#mrFromProv").value, fc = FT.$("#mrFromCity").value;
    const tp = FT.$("#mrToProv").value, tc = FT.$("#mrToCity").value;
    if (!fp || !fc || !tp || !tc) return FT.toast("请完整选择出发和到达的省份、城市");
    FT.$("#mrAddBtn").textContent = "定位中…";
    FT.$("#mrAddBtn").disabled = true;
    try {
      const [c1, c2] = await Promise.all([this.resolveCity(fp, fc), this.resolveCity(tp, tc)]);
      if (!c1 || !c2) { FT.toast(`抱歉，未能定位 ${!c1 ? fc : tc} 的坐标`); return; }
      this._pushRoute(
        { name: fp === tp ? fc : fp.replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔/g, "").slice(0, 3) + "·" + fc, coord: [Number(c1[0].toFixed(2)), Number(c1[1].toFixed(2))] },
        { name: fp === tp ? tc : tp.replace(/省|市|自治区|特别行政区|壮族|回族|维吾尔/g, "").slice(0, 3) + "·" + tc, coord: [Number(c2[0].toFixed(2)), Number(c2[1].toFixed(2))] }
      );
      // 顺便把视角切到终点所在省，看得更清楚
      if (this.provAdcodes[tp]) this.drillDown(this.provAdcodes[tp], tp);
      else this.render();
    } finally {
      FT.$("#mrAddBtn").textContent = "＋ 添加这条路线";
      FT.$("#mrAddBtn").disabled = false;
    }
  },

  _km(a, b) {
    const rad = Math.PI / 180, R = 6371;
    const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  },

  /* ---------- 渲染 ---------- */
  render() {
    if (!this.chart) { this.renderList(); return; }
    const routes = this.visibleRoutes();
    const drill = this.view.adcode !== "100000";

    const startPoints = routes.map(r => ({ name: r.from.name, value: [...r.from.coord, 1] }));
    const endPoints = routes.map(r => ({ name: r.to.name, value: [...r.to.coord, 1] }));
    if (this.pendingFrom) startPoints.push({ name: "起点", value: [...this.pendingFrom.coord, 2] });

    const lines = routes.map(r => ({
      coords: [r.from.coord, r.to.coord],
      km: this._km(r.from.coord, r.to.coord).toLocaleString()
    }));

    const option = {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "item",
        backgroundColor: "rgba(34,48,63,.94)",
        borderWidth: 0,
        textStyle: { color: "#fff", fontSize: 13 },
        formatter: (p) => {
          if (p.seriesType === "lines") return `<b>${p.data.km} 公里</b> 的旅程`;
          if (p.seriesType === "effectScatter") return `<b>${FT.esc(p.name)}</b>`;
          return "";
        }
      },
      geo: {
        map: "china-" + this.view.adcode,
        roam: true,
        zoom: drill ? 1 : 1.15,
        center: drill ? undefined : [104.5, 36.5],
        scaleLimit: { min: .6, max: 14 },
        itemStyle: { areaColor: drill ? "#fdf3e3" : "#fdf3e3", borderColor: "#e8d5b5", borderWidth: 1 },
        emphasis: { itemStyle: { areaColor: "#ffe3c2" }, label: { color: "#8a6a4a" } },
        select: { itemStyle: { areaColor: "#ffe3c2" }, label: { show: true, color: "#8a6a4a" } },
        label: { show: drill, fontSize: 10, color: "#9a7a55" } // 下钻时显示地级市名
      },
      series: [
        {
          name: "路线", type: "lines", coordinateSystem: "geo", zlevel: 2,
          effect: { show: true, period: 4.5, trailLength: .35, symbol: "arrow", symbolSize: 7, color: "#e8622d" },
          lineStyle: { color: "#f2a93b", width: 2.2, opacity: .55, curveness: .25 },
          data: lines
        },
        {
          name: "路线底", type: "lines", coordinateSystem: "geo", zlevel: 1,
          lineStyle: { color: "#d9b98a", width: 1.2, opacity: .4, curveness: .25 },
          data: lines.map(l => ({ coords: l.coords }))
        },
        {
          name: "起点", type: "effectScatter", coordinateSystem: "geo", zlevel: 3,
          rippleEffect: { brushType: "stroke", scale: 3.2, period: 4 },
          symbolSize: 9, itemStyle: { color: "#e8622d" },
          label: { show: true, position: "right", fontSize: 11, fontWeight: 600, color: "#c94a1a" },
          data: startPoints
        },
        {
          name: "终点", type: "effectScatter", coordinateSystem: "geo", zlevel: 3,
          rippleEffect: { brushType: "stroke", scale: 3.2, period: 4 },
          symbolSize: 9, itemStyle: { color: "#2a9d8f" },
          label: { show: true, position: "right", fontSize: 11, fontWeight: 600, color: "#1f7a6e" },
          data: endPoints
        }
      ]
    };
    this.chart.clear();
    this.chart.setOption(option);
    this.renderList();
  },

  renderList() {
    const routes = this.visibleRoutes().slice().sort((a, b) => b.createdAt - a.createdAt);
    FT.$("#routeCount").textContent = routes.length;
    const box = FT.$("#routeList");
    if (!routes.length) {
      box.innerHTML = `<p class="route-empty">还没有路线，点击「添加路线」或用下方「手动选择省市」✈️</p>`;
      return;
    }
    box.innerHTML = routes.map(r => `
      <div class="route-item card">
        <div class="route-line">
          <b>📍 ${FT.esc(r.from.name)}</b>
          <i class="route-arrow"></i>
          <b>🏁 ${FT.esc(r.to.name)}</b>
        </div>
        <span class="route-meta">${FT.esc(FT.ownerName(r.owner))} · ${FT.fmtDate(r.createdAt)} · ${this._km(r.from.coord, r.to.coord).toLocaleString()}km</span>
        ${this.canDelete(r) ? `<button class="route-del" data-id="${r.id}">删除</button>` : ""}
      </div>`).join("");
    FT.$$(".route-del", box).forEach(b => b.addEventListener("click", () => {
      FT.store.set(FT.LS.routes, this.allRoutes().filter(x => x.id !== b.dataset.id));
      FT.toast("路线已删除");
      this.render();
    }));
  }
};
