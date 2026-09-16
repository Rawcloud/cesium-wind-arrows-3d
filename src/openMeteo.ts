/* Open-Meteo 气压层数据 → WindData3D 转换（方法 2：连续方程反算垂直速度 w）
 *
 * Open-Meteo forecast API 是“基于点”的接口，没有边界框参数。要拿到空间网格，
 * 调用方需把一片经纬度网格的所有 (lat,lon) 组合用逗号分隔一次性请求
 * （例如 5×5=25 个点），函数再从响应里按唯一经纬度重建规则网格。
 *
 * 变量命名规则（文档）：`{基础变量名}_{气压层}hPa`，如 wind_speed_850hPa。
 * 本函数需要每个气压层的 wind_speed / wind_direction / temperature / geopotential_height。
 *
 * w 由质量连续方程反算：
 *   ∂u/∂x + ∂v/∂y + ∂ω/∂p = 0   →   ω(p) = -∫ D dp  （顶层 ω=0）
 *   w = -ω · R · T / (g · p)        （ω=dp/dt 气压坐标垂直速度；w=dz/dt 几何垂直速度）
 */

import type { WindData3D } from "./types";
import { normalizeWindData } from "./utils";

/** 气体常数与重力加速度（SI） */
const R_GAS = 287.05;
const GRAV = 9.80665;

export interface OpenMeteoPressureGridOptions {
  /** 气压层（hPa），例如 [500, 700, 850, 925, 1000]。顺序无所谓，函数内部按海拔排序 */
  levels: number[];
  /** 原始 Open-Meteo 多点气压层响应（已 fetch 的 JSON 对象） */
  response: unknown;
  /** 取第几个小时（默认最后一个） */
  hourIndex?: number;
  /** 风速单位，默认 "ms"（需在请求里带 wind_speed_unit=ms） */
  windSpeedUnit?: "ms" | "kmh";
  /** 温度单位，默认 "celsius"（Open-Meteo 默认即摄氏度） */
  temperatureUnit?: "celsius" | "fahrenheit";
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** 从 hourly 变量读取某点某时刻的值；兼容单点（1D）与多点（2D 数组） */
function makeGetter(hourly: Record<string, unknown>, name: string) {
  const raw = hourly[name];
  if (!Array.isArray(raw)) throw new Error(`Open-Meteo 响应缺少变量 ${name}`);
  const is2D = Array.isArray((raw as unknown[])[0]);
  return (loc: number, t: number): number => {
    const v = is2D ? (raw as number[][])[loc]?.[t] : (raw as number[])[t];
    return v == null ? 0 : v;
  };
}

/**
 * 将 Open-Meteo 多点气压层响应转换为符合 WindData3D 契约的数据（含反算的 w）。
 * 返回的对象可直接传给 `new WindArrowLayer(viewer, data)`。
 */
export function fromOpenMeteo(opts: OpenMeteoPressureGridOptions): WindData3D {
  const { levels, response } = opts;
  const hourIndex = opts.hourIndex ?? Number.MAX_SAFE_INTEGER; // 默认取末位，下面取 min
  const speedScale = opts.windSpeedUnit === "kmh" ? 1000 / 3600 : 1; // km/h → m/s
  const tempToK = (c: number) =>
    opts.temperatureUnit === "fahrenheit" ? (c - 32) * 5 / 9 + 273.15 : c + 273.15;

  const resp = response as {
    latitude?: number | number[];
    longitude?: number | number[];
    hourly?: Record<string, unknown>;
  };
  if (!resp.latitude || !resp.longitude || !resp.hourly) {
    throw new Error("Open-Meteo 响应缺少 latitude/longitude/hourly");
  }

  const latArr = Array.isArray(resp.latitude) ? (resp.latitude as number[]) : [resp.latitude as number];
  const lonArr = Array.isArray(resp.longitude) ? (resp.longitude as number[]) : [resp.longitude as number];
  const nPts = latArr.length;
  if (nPts !== lonArr.length) throw new Error("latitude/longitude 点数不一致");

  // 由唯一经纬度重建规则网格（不依赖请求顺序）
  const uniqLat = [...new Set(latArr.map(round6))].sort((a, b) => a - b);
  const uniqLon = [...new Set(lonArr.map(round6))].sort((a, b) => a - b);
  const ny = uniqLat.length;
  const nx = uniqLon.length;
  if (nx < 2 || ny < 2) {
    throw new Error(`网格至少需要 2×2 个点（当前 ${nx}×${ny}）。Open-Meteo 为单点接口，请用逗号分隔请求一片经纬度网格`);
  }
  const latIdx = new Map(uniqLat.map((v, i) => [v, i]));
  const lonIdx = new Map(uniqLon.map((v, i) => [v, i]));
  const west = uniqLon[0];
  const east = uniqLon[nx - 1];
  const south = uniqLat[0];
  const north = uniqLat[ny - 1];
  const midLat = (south + north) / 2;

  // 每个气压层：取 geopotential_height 决定海拔顺序（升序 = 低层在前，符合契约）
  const layerMeta = levels.map((hPa) => {
    const ghGetter = makeGetter(resp.hourly!, `geopotential_height_${hPa}hPa`);
    const gh0 = ghGetter(0, 0);
    if (!Number.isFinite(gh0)) {
      throw new Error(`缺少 geopotential_height_${hPa}hPa（请求时需包含该变量，用于确定层高与 altitude 排序）`);
    }
    return { hPa, gh: gh0 };
  }).sort((a, b) => a.gh - b.gh); // 按海拔升序 → z=0 为最低层
  const nz = layerMeta.length;

  // 取时间索引（默认末位有效小时）
  const tGetter = makeGetter(resp.hourly!, `wind_speed_${layerMeta[0].hPa}hPa`);
  const anyArr = resp.hourly![`wind_speed_${layerMeta[0].hPa}hPa`] as unknown[];
  const tCount = Array.isArray(anyArr[0]) ? (anyArr[0] as number[]).length : (anyArr as number[]).length;
  const t = Math.min(hourIndex, tCount - 1);

  const total = nx * ny * nz;
  const uAll = new Float32Array(total);
  const vAll = new Float32Array(total);
  const tAllK = new Float32Array(total); // 每层温度（K），用于 ω→w
  const pPa = new Float32Array(nz);      // 每层气压（Pa）
  const levelsOut: number[] = [];

  for (let z = 0; z < nz; z++) {
    const { hPa, gh } = layerMeta[z];
    levelsOut.push(gh); // 海拔（米）即契约的 levels
    pPa[z] = hPa * 100;
    const uG = makeGetter(resp.hourly!, `wind_speed_${hPa}hPa`);
    const dG = makeGetter(resp.hourly!, `wind_direction_${hPa}hPa`);
    const tgG = makeGetter(resp.hourly!, `temperature_${hPa}hPa`);
    for (let i = 0; i < nPts; i++) {
      const x = lonIdx.get(round6(lonArr[i]));
      const y = latIdx.get(round6(latArr[i]));
      if (x == null || y == null) continue;
      const spd = (uG(i, t) as number) * speedScale;     // m/s
      const dirFrom = dG(i, t) as number;                 // 气象“来向”（度，顺时针自北）
      const dirRad = (dirFrom * Math.PI) / 180;
      // 气象约定：u 东向、v 北向，风“去向”向量 = (-sin, -cos)
      const u = -spd * Math.sin(dirRad);
      const v = -spd * Math.cos(dirRad);
      const idx = z * ny * nx + y * nx + x;
      uAll[idx] = u;
      vAll[idx] = v;
      tAllK[idx] = tempToK(tgG(i, t) as number);
    }
  }

  // 水平散度 D = ∂u/∂x + ∂v/∂y（经纬度转米，用中纬度量）
  const dLonDeg = uniqLon[1] - uniqLon[0];
  const dLatDeg = uniqLat[1] - uniqLat[0];
  const earthR = 111319.0; // 赤道 1°≈111.32km，中纬近似
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const dxm = dLonDeg * earthR * cosLat; // 经度间距（米）
  const dym = dLatDeg * earthR;          // 纬度间距（米）
  const DAll = new Float32Array(total);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const idx = y * nx + x;
        const base = z * ny * nx + idx;
        const dudx = x > 0 && x < nx - 1
          ? (uAll[base + 1] - uAll[base - 1]) / (2 * dxm)
          : x === 0
            ? (uAll[base + 1] - uAll[base]) / dxm
            : (uAll[base] - uAll[base - 1]) / dxm;
        const dvdy = y > 0 && y < ny - 1
          ? (vAll[base + nx] - vAll[base - nx]) / (2 * dym)
          : y === 0
            ? (vAll[base + nx] - vAll[base]) / dym
            : (vAll[base] - vAll[base - nx]) / dym;
        DAll[base] = dudx + dvdy;
      }
    }
  }

  // 连续方程自顶层向下积分 ω，再换算 w（每层一列独立积分）
  const wAll = new Float32Array(total);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const idx = y * nx + x;
      let om = 0; // 顶层 ω=0
      // 自顶层 (z=nz-1) 向下积分
      for (let z = nz - 2; z >= 0; z--) {
        const dP = pPa[z] - pPa[z + 1]; // Pa，>0（海拔越低气压越大）
        const Dz = DAll[z * ny * nx + idx]; // 用本层散度积分（自顶层 ω=0 向下累加）
        om = om - Dz * dP; // ∂ω/∂p = -D
        const base = z * ny * nx + idx;
        // w = -ω · R · T / (g · p)
        wAll[base] = (-om * R_GAS * tAllK[base]) / (GRAV * pPa[z]);
      }
    }
  }

  return normalizeWindData({
    u: { array: uAll },
    v: { array: vAll },
    w: { array: wAll },
    nx,
    ny,
    nz,
    bounds: { west, south, east, north },
    levels: levelsOut,
  });
}
