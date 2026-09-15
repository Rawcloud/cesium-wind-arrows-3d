/* 箭头蒙皮渲染着色器（DrawCommand）
 * VS：gl_VertexID 反查箭头号 -> 采样锚点与风向 -> ECEF 定位 + ENU 朝向蒙皮
 *     风向含 w 分量，箭头自然带俯仰角（真三维表达）
 * FS：色带着色 + 生命周期渐隐
 * 走 Cesium 自动注入（无显式 #version），out_FragColor 为 Cesium 预声明输出
 */

export const arrowVertShader = `
in vec3 position;   // 箭头局部坐标：x 沿风向（锥尖 1.0，拖尾时杆尾为 -trail），y 侧向，z 向上
in vec3 normal;     // 局部法线（伪光照）
in float aTail;     // 拖尾渐隐系数：0=头部 1=尾端

uniform sampler3D u_wind;
uniform sampler2D u_anchor;
uniform sampler2D u_colorTable;

uniform vec2  u_minLB;
uniform vec2  u_maxLB;
uniform float u_minH;
uniform float u_maxH;
uniform float u_heightScale;
uniform float u_heightOffset;  // 高度整体偏移（米），把风场整体抬升/下沉
uniform float u_texSize;       // 锚点纹理边长（texel 布局 size×size）
uniform float u_scale;         // 世界米/箭头单位长 = lengthPx × pixelSize × arrowScale
uniform float u_trailScale;    // 世界米/拖尾单位长（封顶后）：低空与 u_scale 一致，高空限幅避免重叠密集
uniform vec2  u_domain;        // 色带映射域 (m/s)
uniform vec2  u_displayRange;  // 显示范围 (m/s)
uniform float u_maxLife;
uniform float u_zLock;
uniform float u_activeCount;   // 活跃箭头数：视角拉远时抽稀，防止屏幕墨水饱和成实心色块

out vec4 v_color;
out float v_tail;

const int VERTS_PER_ARROW = 9;

vec3 getWind(vec3 lonLatZ) {
  vec2 p = clamp(lonLatZ.xy, u_minLB, u_maxLB);
  vec2 n = (p - u_minLB) / (u_maxLB - u_minLB);
  return texture(u_wind, vec3(n, clamp(lonLatZ.z, 0.0, 1.0))).xyz;
}

// WGS84 (lon°, lat°, zNorm) -> ECEF
vec3 toEcef(vec3 lonLatZ) {
  float a = 6378137.0;
  float e2 = 6.69437999014e-3;
  float lat = radians(lonLatZ.y);
  float lon = radians(lonLatZ.x);
  float h = mix(u_minH, u_maxH, lonLatZ.z) * u_heightScale + u_heightOffset;
  float cosLat = cos(lat);
  float sinLat = sin(lat);
  float N = a / sqrt(1.0 - e2 * sinLat * sinLat);
  return vec3(
    (N + h) * cosLat * cos(lon),
    (N + h) * cosLat * sin(lon),
    ((1.0 - e2) * N + h) * sinLat
  );
}

// 东-北-上局部三轴（列向量）
mat3 enuMatrix(float latDeg, float lonDeg) {
  float lat = radians(latDeg);
  float lon = radians(lonDeg);
  float cosLat = cos(lat);
  float sinLat = sin(lat);
  vec3 east  = vec3(-sin(lon), cos(lon), 0.0);
  vec3 north = vec3(-sinLat * cos(lon), -sinLat * sin(lon), cosLat);
  vec3 up    = vec3(cosLat * cos(lon), cosLat * sin(lon), sinLat);
  return mat3(east, north, up);
}

void main() {
  int arrowIdx = gl_VertexID / VERTS_PER_ARROW;
  float fi = float(arrowIdx);

  // 拉远视角抽稀：超出活跃数的箭头直接裁掉。
  // 锚点索引与空间位置无关，前缀子集在空间上仍均匀分布，视觉密度一致降低
  if (fi >= u_activeCount) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    v_color = vec4(0.0);
    return;
  }

  float size = u_texSize;
  vec2 texel = (vec2(mod(fi, size), floor(fi / size)) + 0.5) / size;
  vec4 a = texture(u_anchor, texel);

  vec3 wind = getWind(a.xyz);
  float spd = length(wind);

  // 显示范围过滤：速度超界直接裁掉
  if (spd < u_displayRange.x || spd > u_displayRange.y) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    v_color = vec4(0.0);
    return;
  }

  float t = clamp((spd - u_domain.x) / max(u_domain.y - u_domain.x, 1e-5), 0.0, 1.0);
  vec3 rgb = texture(u_colorTable, vec2(t, 0.5)).rgb;

  // 生命周期渐隐：重生淡入，临终淡出
  float fade = smoothstep(0.0, 6.0, a.w) * (1.0 - smoothstep(0.86, 1.0, a.w / max(u_maxLife, 1.0)));

  // ECEF 定位与 ENU 朝向
  vec3 ecef = toEcef(vec3(a.xy, a.z));
  mat3 enu = enuMatrix(a.y, a.x);
  vec3 windEcef = enu * wind;
  float windLen = length(windEcef);
  vec3 dir = windLen > 1e-3 ? windEcef / windLen : enu[0];   // 微风兜底：指东
  vec3 up = enu[2];
  vec3 side = normalize(cross(dir, up) + enu[0] * 1e-5);      // 垂直风兜底
  vec3 up2 = cross(side, dir);

  // 拖尾段（x<0）用封顶后的 trailScale，头部/杆身用 u_scale：
  // 缩小到中高空时 pixelSize 被钳制，若拖尾仍随 pixelSize 无限拉长（可达 100+km），
  // 相邻箭头会严重重叠堆叠成密集色块；封顶后拖尾在屏幕上自然变短
  float sx = position.x < 0.0 ? u_trailScale : u_scale;
  vec3 world = ecef + (dir * position.x * sx + side * position.y * u_scale + up2 * position.z * u_scale);

  // 伪光照：局部上方向亮、侧向暗，箭头小几何足够
  float shade = 0.72 + 0.28 * abs(normal.z);
  v_color = vec4(rgb * shade, fade);
  v_tail = aTail;

  gl_Position = czm_modelViewProjection * vec4(world, 1.0);
}
`;

export const arrowFragShader = `
in vec4 v_color;
in float v_tail;

void main() {
  // 拖尾渐隐：尾端淡到 0，形成彗尾流线感（无拖尾时 v_tail 恒 0，整根实心不影响）
  float alpha = v_color.a * (1.0 - v_tail * v_tail);
  out_FragColor = vec4(v_color.rgb, alpha);
}
`;
