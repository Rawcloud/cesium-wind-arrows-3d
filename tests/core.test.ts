import { describe, it, expect } from "vitest";
import { deepMerge, lonLatLengthMeters, computeSpeedFromComponents, normalizeWindData, seedAreaJumped } from "../src/utils";
import { fromOpenMeteo } from "../src/openMeteo";
import { parseCssColor, makeColorTable } from "../src/colors";
import { buildArrowMesh, VERTS_PER_ARROW, TRIS_PER_ARROW } from "../src/arrowMesh";

describe("seedAreaJumped", () => {
  it("面积比在 [1/1.5, 1.5] 内不触发", () => {
    expect(seedAreaJumped(100, 100)).toBe(false);
    expect(seedAreaJumped(100, 67)).toBe(false);
    expect(seedAreaJumped(100, 149)).toBe(false);
  });
  it("面积比超过 1.5x 或低于 1/1.5x 触发重排", () => {
    expect(seedAreaJumped(100, 66)).toBe(true);
    expect(seedAreaJumped(100, 151)).toBe(true);
  });
  it("首次计算（prev<=0）不触发", () => {
    expect(seedAreaJumped(0, 100)).toBe(false);
    expect(seedAreaJumped(-1, 100)).toBe(false);
  });
});

describe("buildArrowMesh trail", () => {
  it("trail=0 时杆尾在 x=0，行为与旧版一致", () => {
    const m = buildArrowMesh(2, 0);
    expect(m.tails.length).toBe(2 * VERTS_PER_ARROW);
    expect(m.positions[0]).toBe(0);   // 杆尾顶点 0 的 x
    expect(m.positions[8 * 3]).toBe(1); // 锥尖 x
  });
  it("trail>0 时杆尾延长到 -trail，拖尾系数正确", () => {
    const m = buildArrowMesh(1, 4);
    expect(m.positions[0]).toBe(-4); // 杆尾顶点 0 的 x
    expect(m.tails[0]).toBe(1);      // 杆尾 = 1
    expect(m.tails[4]).toBe(0);      // 杆身前端 = 0
    expect(m.tails[8]).toBe(0);      // 锥尖 = 0
    expect(m.verticesPerArrow).toBe(VERTS_PER_ARROW);
    expect(m.trianglesPerArrow).toBe(TRIS_PER_ARROW);
  });
  it("trail 为负数或非有限值抛错", () => {
    expect(() => buildArrowMesh(1, -1)).toThrow();
    expect(() => buildArrowMesh(1, NaN)).toThrow();
  });
});

describe("lonLatLengthMeters", () => {
  it("赤道处纬线 1 度约 111.32km", () => {
    const [lonLen] = lonLatLengthMeters(0);
    expect(lonLen).toBeGreaterThan(111280);
    expect(lonLen).toBeLessThan(111330);
  });
  it("纬度 60 度处纬线长度约为赤道一半", () => {
    const [lonLen60] = lonLatLengthMeters(60);
    expect(lonLen60).toBeGreaterThan(55200);
    expect(lonLen60).toBeLessThan(56000);
  });
  it("经线 1 度约 110.57~111.69km", () => {
    const [, latLen] = lonLatLengthMeters(30);
    expect(latLen).toBeGreaterThan(110570);
    expect(latLen).toBeLessThan(111700);
  });
});

describe("parseCssColor", () => {
  it("支持 hex 三/六/八位", () => {
    expect(parseCssColor("#f00")).toEqual([255, 0, 0, 255]);
    expect(parseCssColor("#ff0000")).toEqual([255, 0, 0, 255]);
    expect(parseCssColor("#ff000080")).toEqual([255, 0, 0, 128]);
  });
  it("支持 rgb()/rgba() 与百分比", () => {
    expect(parseCssColor("rgb(175, 240, 91)")).toEqual([175, 240, 91, 255]);
    expect(parseCssColor("rgba(0,0,0,0.5)")).toEqual([0, 0, 0, 128]);
    expect(parseCssColor("rgb(50%, 0%, 0%)")).toEqual([128, 0, 0, 255]);
  });
  it("支持命名色", () => {
    expect(parseCssColor("white")).toEqual([255, 255, 255, 255]);
  });
  it("非法颜色抛错", () => {
    expect(() => parseCssColor("not-a-color")).toThrow();
  });
});

describe("makeColorTable", () => {
  it("生成 256 级 RGBA 表，端点正确", () => {
    const t = makeColorTable(["rgb(0,0,0)", "rgb(255,255,255)"]);
    expect(t.length).toBe(256 * 4);
    expect(t[0]).toBe(0);
    expect(t[(256 - 1) * 4]).toBe(255);
  });
  it("少于 2 色抛错", () => {
    expect(() => makeColorTable(["red"])).toThrow();
  });
});

describe("computeSpeedFromComponents", () => {
  it("三维幅值合成", () => {
    const r = computeSpeedFromComponents(new Float32Array([3]), new Float32Array([4]), new Float32Array([0]));
    expect(r.array[0]).toBe(5);
    expect(r.min).toBe(5);
    expect(r.max).toBe(5);
  });
  it("NaN/缺测按 0 处理且不污染 min/max", () => {
    const u = new Float32Array([3, NaN, 6]);
    const v = new Float32Array([4, 1, 8]);
    const w = new Float32Array([0, 1, 0]);
    const r = computeSpeedFromComponents(u, v, w);
    expect(r.array[1]).toBe(0);
    expect(r.min).toBe(5);
    expect(r.max).toBe(10);
  });
});

describe("normalizeWindData", () => {
  it("普通数组转 Float32Array 并补 speed", () => {
    const raw = {
      u: { array: [3, 0] }, v: { array: [4, 0] }, w: { array: [0, 0] },
      nx: 1, ny: 1, nz: 2,
      bounds: { west: 100, south: 0, east: 101, north: 1 },
      levels: [0, 100],
    };
    const d = normalizeWindData(raw as never);
    expect(d.u.array).toBeInstanceOf(Float32Array);
    expect(d.speed!.max).toBe(5);
  });
  it("缺 levels 抛错", () => {
    const raw = {
      u: { array: [0] }, v: { array: [0] }, w: { array: [0] },
      nx: 1, ny: 1, nz: 1, bounds: { west: 0, south: 0, east: 1, north: 1 },
    };
    expect(() => normalizeWindData(raw as never)).toThrow();
  });
});

describe("deepMerge", () => {
  it("from 覆盖 to，undefined 跳过", () => {
    const to = { a: 1, b: { c: 2 }, d: 4 };
    const r = deepMerge({ b: { c: 9 }, d: undefined } as never, to);
    expect(r).toEqual({ a: 1, b: { c: 9 }, d: 4 });
  });
});

/** 构造一个最小的 Open-Meteo 多点气压层响应（2×2 网格 × 2 层），用于验证转换。
 *  多点布局：hourly 变量为 外层=地点(4)、内层=时间(1) 的二维数组。 */
function mockOpenMeteoResponse() {
  // 2×2 网格，行优先展开：loc0(39.7,116.2) loc1(39.7,116.3) loc2(39.8,116.2) loc3(39.8,116.3)
  // 低层(1000hPa) u 在 x 方向 +10→-10 变化 → 存在散度；顶层(500hPa)均匀 → 散度为 0
  const lats = [39.7, 39.7, 39.8, 39.8];
  const lons = [116.2, 116.3, 116.2, 116.3];
  const hourly: Record<string, number[][]> = {
    time: [[0], [0], [0], [0]],
    wind_speed_1000hPa: [[10], [10], [10], [10]],
    wind_direction_1000hPa: [[270], [90], [270], [90]], // 来向：270=西风(向东 u+), 90=东风(向西 u-)
    temperature_1000hPa: [[15], [15], [15], [15]],
    geopotential_height_1000hPa: [[100], [100], [100], [100]],
    wind_speed_500hPa: [[10], [10], [10], [10]],
    wind_direction_500hPa: [[270], [270], [270], [270]],
    temperature_500hPa: [[-20], [-20], [-20], [-20]],
    geopotential_height_500hPa: [[5500], [5500], [5500], [5500]],
  };
  return { latitude: lats, longitude: lons, hourly };
}

describe("fromOpenMeteo", () => {
  it("由多点响应重建 2×2 网格并产出合法 WindData3D", () => {
    const d = fromOpenMeteo({ levels: [1000, 500], response: mockOpenMeteoResponse(), windSpeedUnit: "ms" });
    expect(d.nx).toBe(2);
    expect(d.ny).toBe(2);
    expect(d.nz).toBe(2);
    expect(d.bounds).toEqual({ west: 116.2, south: 39.7, east: 116.3, north: 39.8 });
    expect(d.levels.length).toBe(2);
    expect(d.levels[0]).toBeLessThan(d.levels[1]); // 按海拔升序
    expect(d.u.array.length).toBe(2 * 2 * 2);
  });

  it("风向(来向)换算为 u/v 去向向量", () => {
    const d = fromOpenMeteo({ levels: [1000, 500], response: mockOpenMeteoResponse(), windSpeedUnit: "ms" });
    // 1000hPa 点(0,0): 来向270°(西风) → 去向向东 → u>0, v=0
    const idx = 0 * 2 * 2 + 0 * 2 + 0;
    expect(d.u.array[idx]).toBeCloseTo(10, 5);
    expect(Math.abs(d.v.array[idx])).toBeLessThan(1e-3);
  });

  it("低层散度反算出非零 w（连续方程链路生效）", () => {
    const d = fromOpenMeteo({ levels: [1000, 500], response: mockOpenMeteoResponse(), windSpeedUnit: "ms" });
    // w 应有限；低层有散度 → 至少部分 w 非零（否则反算链路失效）
    let nonzero = 0;
    for (let i = 0; i < d.w.array.length; i++) {
      expect(Number.isFinite(d.w.array[i])).toBe(true);
      if (Math.abs(d.w.array[i]) > 1e-6) nonzero++;
    }
    expect(nonzero).toBeGreaterThan(0);
  });

  it("单点响应（<2×2）抛错提示需网格", () => {
    const bad = { latitude: [39.7], longitude: [116.2], hourly: mockOpenMeteoResponse().hourly };
    expect(() => fromOpenMeteo({ levels: [1000, 500], response: bad })).toThrow(/网格/);
  });

  it("缺 geopotential_height 抛错", () => {
    const r = mockOpenMeteoResponse();
    delete (r.hourly as Record<string, unknown>).geopotential_height_1000hPa;
    expect(() => fromOpenMeteo({ levels: [1000, 500], response: r })).toThrow(/geopotential_height/);
  });
});

describe("buildArrowMesh", () => {
  it("顶点/三角数量正确，索引不越界", () => {
    const n = 128;
    const m = buildArrowMesh(n);
    expect(m.positions.length).toBe(n * VERTS_PER_ARROW * 3);
    expect(m.indices.length).toBe(n * TRIS_PER_ARROW * 3);
    for (let i = 0; i < m.indices.length; i++) {
      expect(m.indices[i]).toBeLessThan(n * VERTS_PER_ARROW);
      expect(m.indices[i]).toBeGreaterThanOrEqual(0);
    }
  });
  it("箭头几何在单位包络内", () => {
    const m = buildArrowMesh(1);
    for (let i = 0; i < m.positions.length; i += 3) {
      expect(m.positions[i]).toBeGreaterThanOrEqual(0);
      expect(m.positions[i]).toBeLessThanOrEqual(1);
    }
  });
});
