/* 通用工具：选项合并、经纬度米长、风速幅值合成（含缺测防护） */

import type { WindData3D } from "./types";

/** 深合并（from 覆盖 to），数组整体替换；供 updateOptions 使用 */
export function deepMerge<T extends Record<string, unknown>>(from: Partial<T> | undefined, to: T): T {
  if (!from) return to;
  const result: Record<string, unknown> = { ...to };
  for (const key of Object.keys(from) as (keyof T)[]) {
    const fv = from[key];
    if (fv === undefined) continue;
    const tv = to[key];
    if (Array.isArray(fv)) {
      result[key as string] = fv.slice();
    } else if (fv && typeof fv === "object") {
      result[key as string] = deepMerge(
        fv as Record<string, unknown>,
        (tv && typeof tv === "object" ? tv : {}) as Record<string, unknown>
      );
    } else {
      result[key as string] = fv;
    }
  }
  return result as T;
}

/**
 * 该纬度处经度 1° / 纬度 1° 对应的米数（WGS84 子午线/纬线弧长级数展开）。
 * 返回 [每度经度米数, 每度纬度米数]。与着色器内公式保持一致。
 */
export function lonLatLengthMeters(latDeg: number): [number, number] {
  const lat = (latDeg * Math.PI) / 180;
  const latLen =
    111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat) - 0.0023 * Math.cos(6 * lat);
  const lonLen =
    111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat) + 0.118 * Math.cos(5 * lat);
  return [lonLen, latLen];
}

/**
 * 由 u/v/w 合成风速幅值数组并统计非缺测范围。
 * NaN / 非有限值（气象缺测常见）按 0 处理，不污染 min/max。
 */
export function computeSpeedFromComponents(
  u: Float32Array,
  v: Float32Array,
  w: Float32Array
): { array: Float32Array; min: number; max: number } {
  const n = Math.min(u.length, v.length, w.length);
  const array = new Float32Array(u.length);
  let min = Number.MAX_VALUE;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const a = u[i];
    const b = v[i];
    const c = w[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
      array[i] = 0;
      continue;
    }
    const s = Math.sqrt(a * a + b * b + c * c);
    array[i] = s;
    if (s > 0) {
      if (s < min) min = s;
      if (s > max) max = s;
    }
  }
  if (min === Number.MAX_VALUE) min = 0;
  return { array, min, max };
}

/**
 * 播种范围面积突变检测：面积比 >1.5x 或 <1/1.5x 视为缩放跳变。
 * 用于触发全体粒子重排——否则放大时被压缩进小范围的粒子，
 * 缩回大范围后要等寿命到期才散开，形成高密度残留带。
 * 阈值取 1.5x（原 2x 过宽，连续缩放时中间态会残留明显聚集）：
 * 任意方向缩放约 ±22% 即重排，确保任意缩放级别下视野内密度恒定。
 */
export function seedAreaJumped(prevArea: number, nextArea: number): boolean {
  if (!(prevArea > 0)) return false; // 首次计算不触发
  const ratio = nextArea / prevArea;
  return ratio < 0.667 || ratio > 1.5;
}

/** 校验并规范化风场数据（普通数组转 Float32Array，补 speed），不符合契约直接抛错 */
export function normalizeWindData(raw: Partial<WindData3D> & Record<string, unknown>): WindData3D {
  for (const key of ["u", "v", "w"]) {
    const comp = raw[key] as { array?: unknown } | undefined;
    if (!comp || !comp.array) throw new Error(`WindData3D 缺少分量 ${key}.array`);
  }
  const nx = raw.nx as number;
  const ny = raw.ny as number;
  const nz = raw.nz as number;
  if (!nx || !ny || !nz) throw new Error("WindData3D 缺少 nx/ny/nz");
  const total = nx * ny * nz;
  const bounds = raw.bounds as WindData3D["bounds"];
  const levels = raw.levels as number[];
  if (!bounds || !levels || levels.length !== nz) {
    throw new Error("WindData3D 需要 bounds 与长度为 nz 的 levels（每层海拔米数，升序）");
  }
  const mk = (a: unknown) => (a instanceof Float32Array ? a : new Float32Array(a as ArrayLike<number>));
  const data: WindData3D = {
    u: { array: mk((raw.u as { array: unknown }).array) },
    v: { array: mk((raw.v as { array: unknown }).array) },
    w: { array: mk((raw.w as { array: unknown }).array) },
    nx, ny, nz,
    bounds: { ...bounds },
    levels: [...levels],
  };
  if (data.u.array.length !== total) {
    throw new Error(`u.array 长度 ${data.u.array.length} != nx*ny*nz (${total})`);
  }
  const rawSpeed = raw.speed as WindData3D["speed"] | undefined;
  const speedComplete =
    rawSpeed && rawSpeed.array && rawSpeed.array.length === total &&
    typeof rawSpeed.min === "number" && typeof rawSpeed.max === "number";
  data.speed = speedComplete
    ? { array: mk(rawSpeed.array), min: rawSpeed.min, max: rawSpeed.max }
    : computeSpeedFromComponents(data.u.array, data.v.array, data.w.array);
  return data;
}
