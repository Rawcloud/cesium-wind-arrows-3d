/* 箭头静态网格生成器：单位长 3D 箭头（杆身四棱柱 + 锥头四棱锥），纯函数可单测
 * trail > 0 时杆尾沿 -x 延长为渐隐拖尾（彗尾流线），顶点/三角数不变，零额外开销
 */

export interface ArrowMesh {
  /** 局部坐标：x 沿风向（锥尖 1.0，trail>0 时杆尾为 -trail），y 侧向，z 向上 */
  positions: Float32Array;
  /** 局部法线（伪光照用） */
  normals: Float32Array;
  /** 拖尾渐隐系数：0=头部 1=尾端（FS 按 aTail 做 alpha 渐隐） */
  tails: Float32Array;
  indices: Uint32Array;
  verticesPerArrow: number;
  trianglesPerArrow: number;
}

/** 顶点数：杆尾 4 + 锥底 4 + 锥尖 1 = 9；三角 16（cull 关闭，单面即可） */
export const VERTS_PER_ARROW = 9;
export const TRIS_PER_ARROW = 16;

/**
 * 生成单位箭头网格。
 * 布局：箭头 i 的顶点范围 [i*9, i*9+9)，渲染端按 gl_VertexID/9 反查箭头号。
 * trail：拖尾长度（箭头基准长的倍数，0 = 无拖尾）。
 * n 为箭头总数，重复同一模板（演示端按需展开；库内部按 arrowCount 生成）。
 */
export function buildArrowMesh(n: number, trail = 0): ArrowMesh {
  if (!Number.isFinite(n) || n < 1) throw new Error("箭头数量必须 >= 1");
  if (!Number.isFinite(trail) || trail < 0) throw new Error("trail 必须 >= 0");
  // 杆身半宽 / 锥底半宽 / 锥底位置 / 锥尖位置
  const h = 0.06;                          // 杆身 / 锥底半宽（加宽，远看不再是发丝线）
  const xb = 0.5;                          // 锥底 x：锥头占后半，更醒目
  const s = Math.SQRT1_2;
  const hasTrail = trail > 0;
  const xTail = hasTrail ? -trail : 0;     // 杆尾 x（trail=0 时为 0，无拖尾）
  const hTail = hasTrail ? h * 0.22 : h;   // 拖尾端半宽：收窄成彗尾；无拖尾时等于杆宽

  // 9 个模板顶点（局部坐标 + 法线 + 拖尾系数）
  const P: number[][] = [
    [xTail, -hTail, -hTail], [xTail, hTail, -hTail], [xTail, hTail, hTail], [xTail, -hTail, hTail], // 杆尾（拖尾端，收窄）
    [xb, -h, -h], [xb, h, -h], [xb, h, h], [xb, -h, h],             // 杆身前端
    [1.0, 0.0, 0.0],                                                 // 锥尖
  ];
  const N: number[][] = [
    [-s, -s, 0], [-s, s, 0], [-s, s, s], [-s, -s, s],
    [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0],
    [1, 0, 0],
  ];
  // 拖尾系数：有拖尾时杆尾 4 顶点 = 1，其余 = 0（FS 插值做彗尾渐隐）；
  // 无拖尾时整根箭头实心（全 0），否则杆尾会被淡到接近透明，远看只剩一条线
  const TAIL = hasTrail ? [1, 1, 1, 1, 0, 0, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0, 0, 0];

  // 16 个模板三角（局部索引）
  const T = [
    // 杆身 4 侧面
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
    // 尾盖
    0, 3, 2, 0, 2, 1,
    // 锥体 4 侧面（从锥底四角到锥尖）
    4, 5, 8, 5, 6, 8, 6, 7, 8, 7, 4, 8,
  ];

  const positions = new Float32Array(n * VERTS_PER_ARROW * 3);
  const normals = new Float32Array(n * VERTS_PER_ARROW * 3);
  const tails = new Float32Array(n * VERTS_PER_ARROW);
  const indices = new Uint32Array(n * TRIS_PER_ARROW * 3);

  for (let i = 0; i < n; i++) {
    const base = i * VERTS_PER_ARROW;
    for (let v = 0; v < VERTS_PER_ARROW; v++) {
      const o = (base + v) * 3;
      positions[o] = P[v][0];
      positions[o + 1] = P[v][1];
      positions[o + 2] = P[v][2];
      normals[o] = N[v][0];
      normals[o + 1] = N[v][1];
      normals[o + 2] = N[v][2];
      tails[base + v] = TAIL[v];
    }
    for (let t = 0; t < TRIS_PER_ARROW * 3; t++) {
      indices[i * TRIS_PER_ARROW * 3 + t] = base + T[t];
    }
  }
  return { positions, normals, tails, indices, verticesPerArrow: VERTS_PER_ARROW, trianglesPerArrow: TRIS_PER_ARROW };
}
