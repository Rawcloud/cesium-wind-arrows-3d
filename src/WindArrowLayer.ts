/* WindArrowLayer：多层 (u,v,w) 风场驱动的 3D 箭头图层
 * 数据管线（多层风场、3D 纹理、RK2、单位换算）移植自 cesium-wind-layer-3d（MIT）
 * 渲染形态（静态网格 + 顶点着色器蒙皮箭头）受社区 3D 风向箭头方案启发
 * 全部计算在 GPU：CPU 每帧零工作
 */
import * as Cesium from "cesium";
import type { WindData3D, WindArrowLayerOptions } from "./types";
import { buildArrowMesh, VERTS_PER_ARROW } from "./arrowMesh";
import { makeColorTable } from "./colors";
import { computeSpeedFromComponents, normalizeWindData, lonLatLengthMeters, seedAreaJumped } from "./utils";
import { anchorComputeShader } from "./shaders/computing";
import { arrowVertShader, arrowFragShader } from "./shaders/skinning";

/** 拖尾世界长度限幅（米）：缩小到中高空时避免箭头拖尾重叠成密集色块 */
const TRAIL_MAX_METERS = 8000;

/** 密度抽稀基准相机高度（米）：低于此高度全量渲染，高于此高度按 (refH/camH)^1.5 抽稀 */
const DENSITY_REF_HEIGHT = 2000;
/** 抽稀下限比例：拉到再远也保留 6% 箭头，保证数据范围仍可辨识 */
const DENSITY_MIN_FRAC = 0.46;

interface LayerDefaults {
  arrowCount: number;
  arrowLengthPx: number;
  arrowScale: number;
  flowScale: number;
  maxLife: number;
  colors: string[];
  heightLevel: number | null;
  heightScale: number;
  heightOffset: number;
  trail: number;
  dynamic: boolean;
  flipY: boolean;
}

const DEFAULTS: LayerDefaults = {
  arrowCount: 16384,
  arrowLengthPx: 26,
  arrowScale: 1,
  flowScale: 1500,
  maxLife: 900,
  colors: [
    "rgb(24, 78, 165)", "rgb(38, 130, 205)", "rgb(64, 196, 198)",
    "rgb(150, 230, 140)", "rgb(248, 216, 90)", "rgb(244, 128, 62)", "rgb(210, 48, 60)",
  ],
  heightLevel: null,
  heightScale: 1,
  heightOffset: 0,
  trail: 0,
  dynamic: true,
  flipY: false,
};

export class WindArrowLayer {
  private _show = true;
  private _destroyed = false;

  private viewer: Cesium.Viewer;
  private scene: Cesium.Scene;
  private windData: WindData3D;
  private options: LayerDefaults & {
    domain?: [number, number];
    displayRange?: [number, number];
    sowBounds?: { west: number; south: number; east: number; north: number };
  };

  private heightLevel: number | null;
  private frameRate = 60;
  private frameRateAdjustment = 1;
  private randomSeed = 0.618;

  private windTexture: Cesium.Texture3D | null = null;
  private colorTable: Cesium.Texture | null = null;
  private anchorCur: Cesium.Texture | null = null;
  private anchorNext: Cesium.Texture | null = null;
  private texSize = 128;

  private computePrimitive: Cesium.Primitive | null = null;
  private drawPrimitive: Cesium.Primitive | null = null;
  private drawCommand: Cesium.DrawCommand | null = null;

  // uniform 缓存的 vec2（避免每帧 GC）
  private _minLB = new Cesium.Cartesian2();
  private _maxLB = new Cesium.Cartesian2();
  private _sowMinLB = new Cesium.Cartesian2();
  private _sowMaxLB = new Cesium.Cartesian2();
  /* 播种范围突变检测：缩放跳变时全体粒子重排，消灭密集残留带 */
  private _needsReseed = false;
  private _reseedActive = false;
  private _sowArea = 0;
  private _domain = new Cesium.Cartesian2();
  private _displayRange = new Cesium.Cartesian2();

  private viewerParams = { pixelSize: 1000 };
  private _camKey = "";
  private frameRateMonitor: Cesium.FrameRateMonitor | null = null;
  private listeners: Cesium.Event.RemoveCallback[] = [];
  private onResize = () => this.updateViewerParameters();

  constructor(viewer: Cesium.Viewer, windData: Partial<WindData3D> & Record<string, unknown>, options: WindArrowLayerOptions = {}) {
    this.viewer = viewer;
    this.scene = viewer.scene;
    const context = this.scene.context as unknown as { webgl2: boolean; colorBufferFloat: boolean };
    if (!context.webgl2) throw new Error("WindArrowLayer 需要 WebGL2（CesiumJS 1.104+ 默认启用）");
    if (!context.colorBufferFloat) throw new Error("WindArrowLayer 需要浮点颜色缓冲扩展 EXT_color_buffer_float");

    this.options = { ...DEFAULTS, ...options } as LayerDefaults & typeof options;
    this.heightLevel = this.options.heightLevel;
    // 兼容 cesium-wind-layer-3d 的 particlesTextureSize（粒子纹理边长，总数=边长²）；
    // 该包的 arrowCount 即 size²，提供时覆盖默认 arrowCount
    const pSize = (options as Partial<WindArrowLayerOptions>).particlesTextureSize;
    if (pSize && pSize > 0) this.options.arrowCount = pSize * pSize;
    this.windData = normalizeWindData(windData);

    this.viewerParams.pixelSize = 1000;

    this.frameRateMonitor = new Cesium.FrameRateMonitor({ scene: this.scene, samplingWindow: 1.0, quietPeriod: 0 });
    this.initFrameRate();

    this.createColorTable();
    this.createWindTexture();
    this.updateViewerParameters();   // 先计算视口播种范围（sow）
    this.rebuildAnchorSystem();      // 再据此初始化粒子，避免初始铺满全数据区

    this.addPrimitives();
    this.setupEventListeners();
  }

  get show() { return this._show; }
  set show(v: boolean) {
    if (this._show === v) return;
    this._show = v;
    if (this.computePrimitive) this.computePrimitive.show = v;
    if (this.drawPrimitive) this.drawPrimitive.show = v;
  }

  /** 当前高度层锁定（zNorm 0~1 或 null） */
  get heightLevelValue() { return this.heightLevel; }
  set heightLevelValue(z: number | null) {
    this.heightLevel = z == null ? null : Math.min(1, Math.max(0, z));
    this.updateViewerParameters(); // 高度层变化会改变像素尺寸基准（相机→风场距离）
  }

  private initFrameRate() {
    const update = () => {
      const fps = this.frameRateMonitor?.lastFramesPerSecond ?? 0;
      if (fps > 20) this.frameRateAdjustment = 60 / Math.max(fps, 1);
    };
    update();
    const id = setInterval(update, 1000);
    const oldDestroy = this.destroy.bind(this);
    this.destroy = () => { clearInterval(id); oldDestroy(); return this; };
  }

  /* ---------- 纹理 ---------- */

  private createColorTable() {
    this.colorTable?.destroy();
    const data = makeColorTable(this.options.colors);
    this.colorTable = new Cesium.Texture({
      context: this.scene.context,
      width: 256,
      height: 1,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      sampler: new Cesium.Sampler({
        minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
        magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
        wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
        wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE,
      }),
      source: { width: 256, height: 1, arrayBufferView: data },
    });
  }

  // (u,v,w) 三分量拼一张 RGBA32F 3D 纹理
  private createWindTexture() {
    this.windTexture?.destroy();
    const { nx, ny, nz, u, v, w } = this.windData;
    const total = nx * ny * nz;
    const data = new Float32Array(total * 4);
    for (let i = 0; i < total; i++) {
      const a = u.array[i], b = v.array[i], c = w.array[i];
      data[i * 4 + 0] = Number.isFinite(a) ? a : 0;
      data[i * 4 + 1] = Number.isFinite(b) ? b : 0;
      data[i * 4 + 2] = Number.isFinite(c) ? c : 0;
      data[i * 4 + 3] = 0;
    }
    this.windTexture = new Cesium.Texture3D({
      context: this.scene.context,
      width: nx,
      height: ny,
      depth: nz,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.FLOAT,
      flipY: this.options.flipY,
      sampler: new Cesium.Sampler({
        minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
        magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
        wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
        wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE,
        wrapR: Cesium.TextureWrap.CLAMP_TO_EDGE,
      }),
      source: { width: nx, height: ny, depth: nz, arrayBufferView: data },
    });
  }

  private createAnchorTexture(data: Float32Array): Cesium.Texture {
    return new Cesium.Texture({
      context: this.scene.context,
      width: this.texSize,
      height: this.texSize,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.FLOAT,
      flipY: false,
      sampler: new Cesium.Sampler({
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMinificationFilter.NEAREST,
      }),
      source: { width: this.texSize, height: this.texSize, arrayBufferView: data },
    });
  }

  private randomAnchorData(): Float32Array {
    const b = this.windData.bounds;
    // 优先用当前视口播种范围；范围未初始化（宽度<=0）时回退到全数据边界
    const loLon = this._sowMaxLB.x > this._sowMinLB.x ? this._sowMinLB.x : b.west;
    const hiLon = this._sowMaxLB.x > this._sowMinLB.x ? this._sowMaxLB.x : b.east;
    const loLat = this._sowMaxLB.y > this._sowMinLB.y ? this._sowMinLB.y : b.south;
    const hiLat = this._sowMaxLB.y > this._sowMinLB.y ? this._sowMaxLB.y : b.north;
    const n = this.texSize * this.texSize;
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      data[i * 4 + 0] = loLon + Math.random() * (hiLon - loLon);
      data[i * 4 + 1] = loLat + Math.random() * (hiLat - loLat);
      data[i * 4 + 2] = Math.random();
      data[i * 4 + 3] = Math.random() * this.options.maxLife; // 相位错开，避免同批重生闪烁
    }
    return data;
  }

  private rebuildAnchorSystem() {
    this.anchorCur?.destroy();
    this.anchorNext?.destroy();
    this.texSize = Math.max(4, Math.ceil(Math.sqrt(Math.max(1, this.options.arrowCount))));
    this.anchorCur = this.createAnchorTexture(this.randomAnchorData());
    this.anchorNext = this.createAnchorTexture(new Float32Array(this.texSize * this.texSize * 4));
  }

  /* ---------- uniforms ---------- */

  private refreshVec2Cache() {
    const b = this.windData.bounds;
    this._minLB.x = b.west; this._minLB.y = b.south;
    this._maxLB.x = b.east; this._maxLB.y = b.north;
    this._sowMinLB.x = b.west; this._sowMinLB.y = b.south;
    this._sowMaxLB.x = b.east; this._sowMaxLB.y = b.north;
    const domain = this.options.domain ?? [this.windData.speed!.min, this.windData.speed!.max];
    this._domain.x = domain[0]; this._domain.y = domain[1];
    const dr = this.options.displayRange ?? [-Infinity, Infinity];
    this._displayRange.x = dr[0]; this._displayRange.y = dr[1];
  }

  private drawUniformMap(): Record<string, () => unknown> {
    return {
      u_wind: () => this.windTexture,
      u_anchor: () => this.anchorCur,
      u_colorTable: () => this.colorTable,
      u_minLB: () => this._minLB,
      u_maxLB: () => this._maxLB,
      u_minH: () => this.windData.levels[0],
      u_maxH: () => this.windData.levels[this.windData.levels.length - 1],
      u_heightScale: () => this.options.heightScale,
      u_heightOffset: () => this.options.heightOffset,
      u_texSize: () => this.texSize,
      u_scale: () => this.options.arrowLengthPx * this.options.arrowScale * this.viewerParams.pixelSize,
      // 拖尾尺寸封顶：低空（pixelSize 小）与 u_scale 一致、屏幕长度恒定；
      // 中高空 pixelSize 被钳制到 1000 后，若拖尾仍等比放大（总长可达 130km），
      // 相邻箭头（间距约数 km~数十 km）会重叠成密集色块 → 世界长度限幅 8km
      u_trailScale: () => {
        const s = this.options.arrowLengthPx * this.options.arrowScale * this.viewerParams.pixelSize;
        const tr = this.options.trail;
        return tr > 0 ? Math.min(s, TRAIL_MAX_METERS / tr) : s;
      },
      u_domain: () => this._domain,
      u_displayRange: () => this._displayRange,
      u_maxLife: () => this.options.maxLife,
      u_zLock: () => (this.heightLevel == null ? -1 : this.heightLevel),
      // 视角拉远时按相机高度抽稀活跃箭头：带彗尾的箭头屏幕墨水覆盖大，
      // 全量渲染在拉远视角会叠成实心色块；推近（低于基准高度）恢复全量。
      // 锚点索引与位置无关，前缀子集空间上仍均匀分布
      u_activeCount: () => {
        const carto = this.viewer.camera.positionCartographic;
        const camH = carto ? Math.max(carto.height, 1) : 1000000;
        const frac = Math.max(Math.min(1, Math.pow(DENSITY_REF_HEIGHT / camH, 1.5)), DENSITY_MIN_FRAC);
        return this.texSize * this.texSize * frac;
      },
    };
  }

  /* ---------- primitives ---------- */

  private addPrimitives() {
    this.refreshVec2Cache();
    const that = this;

    /* ---- 锚点平流（ComputeCommand + ping-pong）---- */
    const computeCommand = new Cesium.ComputeCommand({
      owner: this,
      fragmentShaderSource: new Cesium.ShaderSource({ sources: [anchorComputeShader] }),
      outputTexture: this.anchorNext!,
      persists: true,
      uniformMap: {
        u_wind: () => that.windTexture,
        u_anchor: () => that.anchorCur,
        u_minLB: () => that._minLB,
        u_maxLB: () => that._maxLB,
        u_sowMinLB: () => that._sowMinLB,
        u_sowMaxLB: () => that._sowMaxLB,
        u_reseed: () => (that._reseedActive ? 1 : 0),
        u_minH: () => that.windData.levels[0],
        u_maxH: () => that.windData.levels[that.windData.levels.length - 1],
        u_zLock: () => (that.heightLevel == null ? -1 : that.heightLevel),
        u_maxLife: () => that.options.maxLife,
        u_random: () => that.randomSeed,
        u_dtScale: () => that.options.dynamic ? (that.options.flowScale / 60) * that.frameRateAdjustment : 0,
      },
    });
    this.computePrimitive = {
      show: true,
      update(frameState: Cesium.FrameState) {
        if (!that.options.dynamic) return;
        that.randomSeed = Math.random();
        // 播种范围突变 → 本帧全体粒子重生（写入 next 纹理，swap 后生效），消灭缩放后的密集残留带
        that._reseedActive = that._needsReseed;
        that._needsReseed = false;
        // swap：cur <- next <- cur
        const t = that.anchorCur;
        that.anchorCur = that.anchorNext;
        that.anchorNext = t;
        computeCommand.outputTexture = that.anchorNext!;
        frameState.commandList.push(computeCommand);
      },
      isDestroyed: () => false,
      destroy() {
        computeCommand.shaderProgram = computeCommand.shaderProgram && computeCommand.shaderProgram.destroy();
        return Cesium.destroyObject(this);
      },
    } as unknown as Cesium.Primitive;

    /* ---- 箭头绘制（DrawCommand，静态网格蒙皮）---- */
    const arrowCount = this.texSize * this.texSize;
    const mesh = buildArrowMesh(arrowCount, this.options.trail);
    const geometry = new Cesium.Geometry({
      attributes: new (Cesium.GeometryAttributes as any)({
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: mesh.positions,
        }),
        normal: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: mesh.normals,
        }),
        aTail: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 1,
          values: mesh.tails,
        }),
      }),
      indices: mesh.indices,
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(mesh.positions),
    });
    const attributeLocations = { position: 0, normal: 1, aTail: 2 };
    this.drawCommand = new Cesium.DrawCommand({
      owner: this,
      vertexArray: Cesium.VertexArray.fromGeometry({
        context: this.scene.context,
        geometry,
        attributeLocations,
        bufferUsage: Cesium.BufferUsage.STATIC_DRAW,
      }),
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      uniformMap: this.drawUniformMap(),
      shaderProgram: Cesium.ShaderProgram.fromCache({
        context: this.scene.context,
        attributeLocations,
        vertexShaderSource: new Cesium.ShaderSource({ sources: [arrowVertShader] }),
        fragmentShaderSource: new Cesium.ShaderSource({ sources: [arrowFragShader] }),
      }),
      renderState: Cesium.RenderState.fromCache({
        depthTest: { enabled: true, mask: false },   // 读地形深度实现遮挡，不写深度
        blending: Cesium.BlendingState.ALPHA_BLEND,
      }),
      pass: Cesium.Pass.TRANSLUCENT,
      // 包住地球的包围球：箭头由 VS 在 ECEF 布置，视锥剔除交给 GPU 裁剪
      boundingSphere: new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, 6378137 * 2),
    });
    this.drawPrimitive = {
      show: true,
      update(frameState: Cesium.FrameState) {
        // 每帧主动检查相机变化（比 camera.changed 事件可靠，虚拟时间/headless 下事件可能不触发）
        const carto = that.scene.camera.positionCartographic;
        if (carto) {
          const key = carto.height.toFixed(0) + "|" +
            Cesium.Math.toDegrees(carto.longitude).toFixed(5) + "|" +
            Cesium.Math.toDegrees(carto.latitude).toFixed(5);
          if (key !== that._camKey) {
            that._camKey = key;
            that.updateViewerParameters();
          }
        }
        frameState.commandList.push(that.drawCommand!);
      },
      isDestroyed: () => false,
      destroy() {
        that.drawCommand!.vertexArray!.destroy();
        that.drawCommand!.shaderProgram = that.drawCommand!.shaderProgram && that.drawCommand!.shaderProgram.destroy();
        return Cesium.destroyObject(this);
      },
    } as unknown as Cesium.Primitive;

    this.scene.primitives.add(this.computePrimitive);
    this.scene.primitives.add(this.drawPrimitive);
  }

  /* ---------- 相机自适应 ---------- */

  private setupEventListeners() {
    this.viewer.camera.percentageChanged = 0.01;
    this.listeners.push(this.viewer.camera.changed.addEventListener(() => this.updateViewerParameters()));
    this.listeners.push(this.scene.morphComplete.addEventListener(() => this.updateViewerParameters()));
    window.addEventListener("resize", this.onResize);
  }

  private updateViewerParameters() {
    if (this._destroyed) return;
    const scene = this.scene;
    const canvas = scene.canvas;
    // pixelSize（米/像素）= 2·H·tan(fov/2)/屏高：基于相机高度，低空/全球视角均成立
    // （原 pickEllipsoid 四角法在低空俯视时因天空角点失效，导致箭头尺寸错误）
    let camHeight = 1000000;
    const carto = scene.camera.positionCartographic;
    if (carto) camHeight = Math.max(carto.height, 1);
    const frustum = scene.camera.frustum as unknown as { fovy?: number };
    const fov = frustum.fovy ?? Math.PI / 3;
    // 像素尺寸基于"相机→风场参考平面"的垂直距离，而非相机→椭球面：
    // 锁定高度层时风场在固定高度，用相机高度会高估 sow 范围与箭头世界尺寸。
    // 参考平面取"有效风场高度"（锁定层，未锁定时取最低层——低层箭头主导视野足迹）；
    // 相机低于该平面时（常见于低空城市视角）回退用相机离地高度，
    // 否则距离被钳成 1m → pixelSize 坍缩到下限 → 播种范围收缩成小方块 → 全体粒子挤成密集团块
    const levels = this.windData.levels;
    const loH = levels[0] * this.options.heightScale + this.options.heightOffset;
    const effH = this.heightLevel != null
      ? (levels[0] + (levels[levels.length - 1] - levels[0]) * this.heightLevel) * this.options.heightScale + this.options.heightOffset
      : loH;
    const distToWind = effH < camHeight ? camHeight - effH : camHeight;
    const pixelSize = (2 * distToWind * Math.tan(fov / 2)) / canvas.clientHeight;
    this.viewerParams.pixelSize = Math.min(1000, Math.max(0.5, pixelSize));

    // 播种范围 = 以画面中心地面拾取点为锚、按 pixelSize×屏幕尺寸外推的经纬度框 ∩ 数据边界
    //（不能用角点拾取：低空时地平线附近像素会拾取到极远的椭球点，把范围撑爆）
    const b = this.windData.bounds;
    let cLon: number | undefined;
    let cLat: number | undefined;
    const centerPick = scene.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      scene.globe.ellipsoid
    );
    if (centerPick) {
      const cg = scene.globe.ellipsoid.cartesianToCartographic(centerPick);
      cLon = Cesium.Math.toDegrees(cg.longitude);
      cLat = Cesium.Math.toDegrees(cg.latitude);
    } else if (carto) {
      cLon = Cesium.Math.toDegrees(carto.longitude);
      cLat = Cesium.Math.toDegrees(carto.latitude);
    }
    if (cLon !== undefined && cLat !== undefined) {
      const [lonLen, latLen] = lonLatLengthMeters(cLat);
      // 跨度下限：数据范围的 0.5%（约数 km），防止极端情况下播种范围退化成小方块，
      // 全部粒子挤成密集团块（截图中"缩放时出现密集团块、过一会儿恢复"即此问题）
      const minSpanLon = (b.east - b.west) * 0.005;
      const minSpanLat = (b.north - b.south) * 0.005;
      const spanLon = Math.max((pixelSize * canvas.clientWidth) / Math.max(lonLen, 1), minSpanLon);
      const spanLat = Math.max((pixelSize * canvas.clientHeight) / Math.max(latLen, 1), minSpanLat);
      const minLon = Math.max(b.west, cLon - spanLon / 2);
      const maxLon = Math.min(b.east, cLon + spanLon / 2);
      const minLat = Math.max(b.south, cLat - spanLat / 2);
      const maxLat = Math.min(b.north, cLat + spanLat / 2);
      // 视口框撞到数据边界（任一方向被裁 >25%）说明视口已偏出/超出数据区，
      // 局部播种会退化为贴边窄条（缩小过程中拾取点漂出边界时尤为明显）
      // → 退回全数据边界播种，避免边缘密集带
      const clipLon = spanLon > 0 ? (maxLon - minLon) / spanLon : 0;
      const clipLat = spanLat > 0 ? (maxLat - minLat) / spanLat : 0;
      if (Math.min(clipLon, clipLat) < 0.75) {
        this._sowMinLB.x = b.west; this._sowMaxLB.x = b.east;
        this._sowMinLB.y = b.south; this._sowMaxLB.y = b.north;
      } else {
        this._sowMinLB.x = minLon; this._sowMaxLB.x = maxLon;
        this._sowMinLB.y = minLat; this._sowMaxLB.y = maxLat;
      }
    } else {
      this._sowMinLB.x = b.west; this._sowMaxLB.x = b.east;
      this._sowMinLB.y = b.south; this._sowMaxLB.y = b.north;
    }

    // 保底播种范围（如白模城市）：与视口框取并集，保证固定区域始终有箭头覆盖
    //（低空视角下视口框可能只罩住目标区域的一部分，导致箭头只悬浮在区域局部上空）
    const sb = this.options.sowBounds;
    if (sb) {
      this._sowMinLB.x = Math.max(b.west, Math.min(this._sowMinLB.x, sb.west));
      this._sowMinLB.y = Math.max(b.south, Math.min(this._sowMinLB.y, sb.south));
      this._sowMaxLB.x = Math.min(b.east, Math.max(this._sowMaxLB.x, sb.east));
      this._sowMaxLB.y = Math.min(b.north, Math.max(this._sowMaxLB.y, sb.north));
    }

    // 播种面积突变（快速缩放 >2x 或 <1/2x）→ 触发全体粒子重排：
    // 否则放大时被压缩进小范围的粒子在缩回后迟迟不散，形成高密度残留带
    const sowArea =
      (this._sowMaxLB.x - this._sowMinLB.x) * (this._sowMaxLB.y - this._sowMinLB.y);
    if (seedAreaJumped(this._sowArea, sowArea)) this._needsReseed = true;
    this._sowArea = sowArea;
  }

  /* ---------- 公开 API ---------- */

  /** 运行时替换风场数据（重建 3D 纹理，箭头系统保持） */
  updateWindData(windData: Partial<WindData3D> & Record<string, unknown>) {
    if (this._destroyed) return;
    this.windData = normalizeWindData(windData);
    this.createWindTexture();
    this.refreshVec2Cache();
    this.scene.requestRender();
  }

  /** 运行时更新参数（浅合并：字段均为基本类型或数组） */
  updateOptions(options: WindArrowLayerOptions) {
    if (this._destroyed) return;
    const prevArrowCount = this.options.arrowCount;
    const prevColors = this.options.colors;
    for (const [k, v] of Object.entries(options)) {
      if (v === undefined) continue;
      (this.options as unknown as Record<string, unknown>)[k] = Array.isArray(v) ? v.slice() : v;
    }
    if (this.options.heightLevel !== undefined) this.heightLevel = this.options.heightLevel;
    if (prevColors !== this.options.colors) this.createColorTable();
    // 兼容 particlesTextureSize：提供时换算为 arrowCount（size²）并强制重建
    if (options.particlesTextureSize && options.particlesTextureSize > 0) {
      this.options.arrowCount = options.particlesTextureSize * options.particlesTextureSize;
    }
    const needRebuild =
      (options.arrowCount !== undefined && options.arrowCount !== prevArrowCount) ||
      options.particlesTextureSize !== undefined;
    this.refreshVec2Cache();
    if (needRebuild) {
      this.scene.primitives.remove(this.computePrimitive);
      this.scene.primitives.remove(this.drawPrimitive);
      this.rebuildAnchorSystem();
      this.addPrimitives();
    }
    this.scene.requestRender();
  }

  /** 相机飞到数据范围 */
  zoomTo(duration = 0) {
    const b = this.windData.bounds;
    this.viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(b.west, b.south, b.east, b.north),
      duration,
    });
  }

  isDestroyed() { return this._destroyed; }

  destroy() {
    if (this._destroyed) return this;
    this._destroyed = true;
    for (const off of this.listeners) off();
    this.listeners = [];
    window.removeEventListener("resize", this.onResize);
    this.frameRateMonitor?.destroy();
    if (this.computePrimitive) this.scene.primitives.remove(this.computePrimitive);
    if (this.drawPrimitive) this.scene.primitives.remove(this.drawPrimitive);
    this.windTexture?.destroy();
    this.colorTable?.destroy();
    this.anchorCur?.destroy();
    this.anchorNext?.destroy();
    this.windTexture = null;
    this.colorTable = null;
    this.anchorCur = null;
    this.anchorNext = null;
    return this;
  }
}

export default WindArrowLayer;
