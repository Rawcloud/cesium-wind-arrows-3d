# cesium-wind-arrows-3d

基于 WebGL2 的 CesiumJS **三维风场箭头图层**：多层 `(u, v, w)` 风场驱动的 3D 箭头场，GPGPU 实现，**CPU 每帧零工作**。

数据契约与 [cesium-wind-layer-3d](https://www.npmjs.com/package/cesium-wind-layer-3d)（流线拖尾形态）完全一致，可互换使用——同一份数据，两种形态。

## 特性

- WebGL2 原生 3D 纹理（`sampler3D`）存储风场，硬件三线性插值
- GPU 粒子平流（Runge-Kutta 2），锚点游动 + 出界/寿命重生，覆盖密度恒定
- 3D 箭头蒙皮：顶点着色器采样锚点与风向组装几何，**风向含 w 分量，箭头自然带俯仰角**（垂直气流可视化）
- 尺寸随相机高度自适应（屏幕像素恒定），帧率无关
- 高度层锁定：一键切换到任意归一化高度层（`?z=0.9` 之类交互由上层实现）
- 风速色带映射、显示范围过滤、NaN/缺测值防护
- 运行时动态替换数据、调参、显隐
- 支持「保底播种范围」与高度偏移，贴合地表/城市白模场景

## 安装

```bash
npm install cesium-wind-arrows-3d
```

`cesium`（^1.142.0）为 peer dependency，需在使用方项目中自行安装。

类型声明随包发布（`dist/types`），TypeScript 项目开箱即用，无需额外安装 `@types`。

**从本地包安装 / 调试：**

```bash
# 直接装打包产物
npm install ../cesium-wind-arrows-3d/cesium-wind-arrows-3d-0.1.8.tgz

# 或软链到源码（改完库代码重新 build 即可生效，无需反复打包）
cd cesium-wind-arrows-3d && npm link
# 在使用方项目：
npm link cesium-wind-arrows-3d
```

## 快速开始

```ts
import * as Cesium from "cesium";
import { WindArrowLayer } from "cesium-wind-arrows-3d";

const viewer = new Cesium.Viewer("container");

const windData = {
  u: { array: uArray },   // Float32Array(nx*ny*nz)，东向风速 m/s
  v: { array: vArray },   // 北向
  w: { array: wArray },   // 垂直（向上为正）
  nx, ny, nz,
  bounds: { west, south, east, north },   // 数据范围（度）
  levels: [500, 1500, 3000, 5500],        // 每层海拔（米，升序）
};

const layer = new WindArrowLayer(viewer, windData, {
  arrowCount: 16384,
  arrowLengthPx: 26,
  colors: ["rgb(24,78,165)", "rgb(64,196,198)", "rgb(248,216,90)", "rgb(210,48,60)"],
});

layer.zoomTo(2);
```

数组布局：`index = (z * ny + y) * nx + x`，x=经度(西→东)，y=纬度(南→北)，z=层(低→高)。普通数组会自动转 `Float32Array`（`normalizeWindData`）。

## 选项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `arrowCount` | `16384` | 箭头总数（取整为 size² 纹理布局） |
| `arrowLengthPx` | `26` | 箭头屏幕像素长度（随相机高度自适应世界尺寸） |
| `arrowScale` | `1` | 箭头长度全局缩放 |
| `flowScale` | `1500` | 锚点游动时间加速倍数（真实风速 1s 走 1s 太慢，可视化需加速） |
| `maxLife` | `900` | 锚点寿命（帧），到期重生 |
| `colors` | 蓝青黄红色带 | CSS 颜色数组（低→高风速） |
| `domain` | 数据幅值范围 | 色带映射域 `[min, max]` (m/s) |
| `displayRange` | 不裁剪 | 显示范围 `[min, max]`，范围外箭头隐藏 |
| `heightLevel` | `null` | `null` 全体均匀分布；`0~1` 锁定到该归一化高度层 |
| `heightScale` | `1` | 高度拉伸系数（在采样之后，仅缩放世界高度） |
| `heightOffset` | `0` | 高度整体偏移（米，海拔），在世界高度上叠加：<br>世界高度 = `mix(levels[0], levels[nz-1], zNorm) * heightScale + heightOffset`<br>用于把风场整体抬升/下沉，贴合地表或城市白模（见下） |
| `sowBounds` | 无 | 保底播种范围（`{west,south,east,north}`，度）。实际播种范围 = 视口范围 ∪ 保底范围（再 ∩ 数据边界），保证固定区域始终有箭头覆盖 |
| `trail` | `0` | 拖尾长度（箭头基准长的倍数）。`0` 无拖尾；`>0` 时杆尾沿来风反方向延长为渐隐彗尾流线（尾端收窄 + 淡到 0），呈现风"掠过"的流线感，典型值 `1.5~3` |
| `dynamic` | `true` | 锚点是否游动（false 为静态） |
| `flipY` | `false` | 数据 JSON 数组行序翻转 |

## 贴合地表 / 城市白模

默认 `heightScale=1` 时，风场最低层（如 500m）会悬在城市白模（屋高 ~280m）上空，观感“脱离”。
两种手段配合使用：

1. **整体下沉**——用 `heightOffset` 把风场按数据层高度整体抬/降，让最低层贴近地面：

   ```ts
   // 数据最低层 500m，城市白模最高 ~280m → 下沉 500m，风场贴近地表
   const layer = new WindArrowLayer(viewer, windData, {
     heightOffset: -500,   // 单位：米（海拔）
   });
   ```

   > 注：仅偏移世界高度，不改变 `zNorm` 采样，仍按真实数据层取风。

2. **保底覆盖**——低空俯视时视口框可能只罩住城市的一部分，导致箭头只悬浮在区域局部上空。
   用 `sowBounds` 框住目标城市，使箭头始终覆盖：

   ```ts
   const layer = new WindArrowLayer(viewer, windData, {
     sowBounds: { west: 104.70, south: -3.05, east: 104.85, north: -2.90 }, // 城市经纬度框
   });
   ```

播种范围自动跟随相机（中心地面拾取点 + 像素尺寸外推），缩放时密度稳定，不会因快速缩放挤出密集团块或残留高密度带。

## API

| 成员 | 说明 |
|---|---|
| `show` | 读写属性，控制显隐 |
| `heightLevelValue` | 读写属性，`null` 表示全体；`0~1` 锁定归一化高度层 |
| `updateWindData(data)` | 运行时替换风场数据（重建 3D 纹理，箭头系统保持） |
| `updateOptions(options)` | 运行时更新参数（浅合并） |
| `zoomTo(duration?)` | 相机飞到数据范围，`duration` 默认 `0`（瞬移） |
| `destroy()` | 释放 GPU 资源，返回 `this` |
| `isDestroyed()` | 是否已销毁 |

```ts
layer.show = false;                              // 隐藏
layer.heightLevelValue = 0.9;                    // 锁定到 90% 高度层
layer.updateOptions({ arrowLengthPx: 40 });      // 运行时调参
layer.updateWindData(otherWindData);             // 换数据
```

## 浏览器要求

- WebGL2（CesiumJS 1.104+ 默认启用）
- `EXT_color_buffer_float` 浮点颜色缓冲扩展

## 本地开发 / 打包

```bash
npm install
npm run dev:example   # 启动示例页（http://localhost:3008），含程序化城市白模
npm test              # 单元测试（vitest）
npm run build         # 构建 dist（含 .d.ts 类型声明）
npm pack              # 生成 cesium-wind-arrows-3d-<version>.tgz
```

示例页访问参数：`?cam=city` 进入城市低空视角；`?z=0.9` 启动时锁定高度层。

## 风场数据从哪来

- **开箱即用**：`cesium-wind-layer-3d` 仓库 example 自带 `wind_3d.json`（印尼区域三维风场，MIT）
- **免费无密钥**：[Open-Meteo](https://open-meteo.com/) 气压层 API（风速+风向→换算 u/v，无 w）
- **完整 w 分量**：ERA5（哥白尼 CDS）或 NOAA GFS GRIB2，注意气压垂直速度（Pa/s）需换算为几何 m/s

## 从 Open-Meteo 接入（无 w 数据）

Open-Meteo 气压层 API 只提供 u/v（风速+风向），无垂直速度 w。本包提供 `fromOpenMeteo()`，
按**质量连续方程反算 w**（方法 2）：`∂u/∂x + ∂v/∂y + ∂ω/∂p = 0` 自顶层（ω=0）向下积分得气压坐标垂直速度 ω，
再换算几何垂直速度 `w = -ω·R·T/(g·p)`。箭头因此带真实俯仰角，立体感最强。

注意：Open-Meteo 是**单点接口**，没有边界框参数。要拿到空间网格，须把一片经纬度网格的所有
`(lat,lon)` 组合用逗号分隔一次性请求（如 5×5=25 个点），`fromOpenMeteo` 再从响应里按唯一经纬度重建规则网格。
请求需含每个气压层的 `wind_speed` / `wind_direction` / `temperature` / `geopotential_height`（变量名形如 `wind_speed_850hPa`）。

```ts
import { fromOpenMeteo } from "cesium-wind-arrows-3d";

const lv = [1000, 925, 850, 700, 500]; // hPa，函数内部按海拔排序
const vars = lv.flatMap((L) => [
  `wind_speed_${L}hPa`, `wind_direction_${L}hPa`,
  `temperature_${L}hPa`, `geopotential_height_${L}hPa`,
]);
const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
  `&hourly=${vars.join(",")}&wind_speed_unit=ms&forecast_days=1`;

const windData = fromOpenMeteo({ levels: lv, response: await (await fetch(url)).json(), windSpeedUnit: "ms" });
// windData 直接传给 new WindArrowLayer(viewer, windData, {...})
```

example 页加 `?src=openmeteo` 即可一键拉取巨港（Palembang）周边 5×5×5 层网格演示（反算 w + 彗尾），并与同一座城市白模叠加。

## License

MIT
