/* 锚点平流计算着色器（ComputeCommand 片元着色器）
 * 状态纹理每 texel 一条箭头：(lon°, lat°, zNorm, life)
 * 每帧：RK2 中点法平流 + 出界/寿命重生
 * 风场采样与单位换算公式与 cesium-wind-layer-3d 保持一致（MIT）
 */
export const anchorComputeShader = `#version 300 es
precision highp float;

uniform sampler3D u_wind;      // RGB = (u, v, w) m/s
uniform sampler2D u_anchor;    // texel = (lon, lat, zNorm, life)

uniform vec2  u_minLB;         // (west, south) 数据边界
uniform vec2  u_maxLB;         // (east, north)
uniform vec2  u_sowMinLB;      // 播种范围（视口∩数据），重生落点用
uniform vec2  u_sowMaxLB;
uniform float u_minH;          // levels[0]
uniform float u_maxH;          // levels[nz-1]
uniform float u_zLock;         // <0 不锁层；[0,1] 锁定归一化高度层
uniform float u_maxLife;       // 寿命（帧）
uniform float u_random;        // 每帧随机种子
uniform float u_dtScale;       // 单帧步长（含时间加速倍率与帧率补偿）
uniform float u_reseed;        // >0.5：播种范围突变，本帧全体粒子立即重生（消灭缩放密集带）

in vec2 v_textureCoordinates;
out vec4 fragColor;

vec3 getWind(vec3 lonLatZ) {
  vec2 p = clamp(lonLatZ.xy, u_minLB, u_maxLB);
  vec2 n = (p - u_minLB) / (u_maxLB - u_minLB);
  return texture(u_wind, vec3(n, clamp(lonLatZ.z, 0.0, 1.0))).xyz;
}

// 该纬度处经/纬 1° 的米数（WGS84 级数展开，与主线程 utils.ts 一致）
vec2 lonLatLen(vec2 lonLat) {
  float lat = radians(lonLat.y);
  float latLen = 111132.92 - 559.82 * cos(2.0 * lat)
               + 1.175 * cos(4.0 * lat) - 0.0023 * cos(6.0 * lat);
  float lonLen = 111412.84 * cos(lat) - 93.5 * cos(3.0 * lat) + 0.118 * cos(5.0 * lat);
  return vec2(lonLen, latLen);
}

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec4 a = texture(u_anchor, v_textureCoordinates);
  vec3 pos = a.xyz;

  bool expired = a.w >= u_maxLife;
  bool reseed = u_reseed > 0.5;
  // 出界以播种范围为准：游出视野即重生回视野，保证任意缩放级别下视野内密度恒定
  bool outside = pos.x < u_sowMinLB.x || pos.x > u_sowMaxLB.x
              || pos.y < u_sowMinLB.y || pos.y > u_sowMaxLB.y
              || pos.z < 0.0 || pos.z > 1.0;

  if (expired || outside || reseed) {
    float r1 = rand(v_textureCoordinates * 97.13 + u_random);
    float r2 = rand(v_textureCoordinates * 31.77 + u_random * 1.37 + 4.1);
    float r3 = rand(v_textureCoordinates * 53.11 + u_random * 2.71 + 9.2);
    float z = u_zLock >= 0.0 ? u_zLock : r3;
    fragColor = vec4(mix(u_sowMinLB.x, u_sowMaxLB.x, r1), mix(u_sowMinLB.y, u_sowMaxLB.y, r2), z, 0.0);
    return;
  }

  // RK2 中点法：m/s -> (deg/s, deg/s, zNorm/s)
  vec2 len = lonLatLen(pos.xy);
  float hRange = max(u_maxH - u_minH, 1.0);
  vec3 f0 = getWind(pos);
  vec3 v0 = vec3(f0.x / len.x, f0.y / len.y, f0.z / hRange);
  vec3 mid = pos + 0.5 * v0 * u_dtScale;
  vec3 f1 = getWind(mid);
  vec3 v1 = vec3(f1.x / len.x, f1.y / len.y, f1.z / hRange);
  pos += v1 * u_dtScale;
  pos.x = clamp(pos.x, u_minLB.x, u_maxLB.x);
  pos.y = clamp(pos.y, u_minLB.y, u_maxLB.y);
  pos.z = clamp(pos.z, 0.0, 1.0);
  if (u_zLock >= 0.0) pos.z = u_zLock;

  fragColor = vec4(pos, a.w + 1.0);
}
`;
