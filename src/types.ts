/* 数据契约与选项类型定义 */

/** 三维风场数据契约（与 cesium-wind-layer-3d 的 WindData3D 完全一致，可互换） */
export interface WindData3D {
  /** 东向风速分量 (m/s)，长度 nx*ny*nz */
  u: { array: Float32Array };
  /** 北向风速分量 (m/s) */
  v: { array: Float32Array };
  /** 垂直风速分量 (m/s，向上为正) */
  w: { array: Float32Array };
  /** 风速幅值，缺省时由 u/v/w 自动合成（自动处理 NaN/缺测） */
  speed?: { array: Float32Array; min: number; max: number };
  /** 经度方向网格数 */
  nx: number;
  /** 纬度方向网格数 */
  ny: number;
  /** 垂直层数 */
  nz: number;
  /** 数据经纬度范围（度） */
  bounds: { west: number; south: number; east: number; north: number };
  /** 每层对应高度（米，海拔，升序），长度 nz */
  levels: number[];
}

export interface WindArrowLayerOptions {
  /** 箭头总数（内部取整为 size×size 的纹理布局），默认 16384 */
  arrowCount?: number;
  /**
   * 兼容别名：粒子纹理边长（参考包 cesium-wind-layer-3d 的 particlesTextureSize），
   * 箭头总数 = size²。提供时覆盖 `arrowCount`。仅构造时与 updateOptions 时生效。
   */
  particlesTextureSize?: number;
  /** 箭头屏幕像素长度（随相机高度自适应世界尺寸），默认 26 */
  arrowLengthPx?: number;
  /** 箭头长度全局缩放，默认 1 */
  arrowScale?: number;
  /** 锚点游动的时间加速倍数（真实风 1s 走 1s 的路太慢，可视化需要加速），默认 1500 */
  flowScale?: number;
  /** 锚点寿命（帧数），到期重生，默认 900 */
  maxLife?: number;
  /** 色带（CSS 颜色数组，低→高风速），默认白→青→紫 */
  colors?: string[];
  /** 色带映射域 [min, max] (m/s)，缺省取数据幅值范围 */
  domain?: [number, number];
  /** 显示范围 [min, max]，范围外箭头隐藏，缺省不裁剪 */
  displayRange?: [number, number];
  /** 高度层锁定：null 均匀分布；0~1 锁定到该归一化层，默认 null */
  heightLevel?: number | null;
  /** 高度拉伸系数，默认 1 */
  heightScale?: number;
  /**
   * 高度整体偏移（米，海拔，默认 0）。在 heightScale 缩放之后叠加：
   * 世界高度 = mix(levels[0], levels[nz-1], zNorm) * heightScale + heightOffset。
   * 用于把风场整体抬升/下沉——例如把最低层(500m)下沉到白模/地面附近，
   * 解决风场与地表建筑"脱离"的观感问题。不改变 zNorm 采样（仍按数据层取风）。
   */
  heightOffset?: number;
  /**
   * 拖尾长度（箭头基准长的倍数，0 = 无拖尾，默认 0）。仅构造时生效（修改需重建图层实例）。
   * >0 时杆尾沿风向反方向延长为渐隐"彗尾"（顶点/三角数不变，GPU 零额外开销）：
   * 尾端收窄 + 不透明度淡到 0，呈现风"掠过"的流线感。
   * 配合 `arrowLengthPx` 使用，典型值 1.5~3；放大到目标区域时流线感更强、效果更突出。
   */
  trail?: number;
  /** 动态更新（锚点游动），false 时静态，默认 true */
  dynamic?: boolean;
  /** 数据 JSON 数组行序翻转，默认 false */
  flipY?: boolean;
  /**
   * 保底播种范围（经纬度度）。实际播种范围 = 视口范围 ∪ 保底范围（再∩数据边界）。
   * 用于"箭头永远覆盖某个固定区域"的场景（如建筑白模城市）：
   * 低空视角下视口框可能只罩住目标区域的一部分，导致箭头只悬浮在区域局部上空。
   */
  sowBounds?: { west: number; south: number; east: number; north: number };
}

/** 相机相关运行参数（内部） */
export interface ViewerParams {
  lonRange: CesiumCartesian2;
  latRange: CesiumCartesian2;
  pixelSize: number;
}

/** 避免类型文件强依赖 cesium 的最小结构 */
export interface CesiumCartesian2 {
  x: number;
  y: number;
}
