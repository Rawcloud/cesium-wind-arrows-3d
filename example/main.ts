import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { WindArrowLayer, normalizeWindData, fromOpenMeteo, type WindData3D } from "../src";

const viewer = new Cesium.Viewer("cesiumContainer", {
  baseLayer: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
});
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0a1628");
viewer.scene.fog.enabled = true;
viewer.scene.fog.density = 0.00008;

let layer: WindArrowLayer | null = null;

function bindControls() {
  const height = document.getElementById("height") as HTMLInputElement;
  const heightVal = document.getElementById("heightVal")!;
  height.addEventListener("input", () => {
    if (Number(height.value) >= 100) {
      layer!.heightLevelValue = null;
      heightVal.textContent = "全体";
    } else {
      layer!.heightLevelValue = Number(height.value) / 100;
      const lv = Math.round(layer!.heightLevelValue! * 10) / 10;
      heightVal.textContent = `z=${lv}`;
    }
  });
  const length = document.getElementById("length") as HTMLInputElement;
  const lenVal = document.getElementById("lenVal")!;
  length.addEventListener("input", () => {
    lenVal.textContent = length.value;
    layer!.updateOptions({ arrowLengthPx: Number(length.value) });
  });
  const flow = document.getElementById("flow") as HTMLInputElement;
  const flowVal = document.getElementById("flowVal")!;
  flow.addEventListener("input", () => {
    flowVal.textContent = flow.value;
    layer!.updateOptions({ flowScale: Number(flow.value) });
  });
  document.getElementById("zoom")!.addEventListener("click", () => layer!.zoomTo(1.5));
}

/** 项目签名演示城市：巨港（Palembang）。白模与 Open-Meteo 数据都围绕它展开，保证两者一致 */
const CITY = { lon: 104.775, lat: -2.976 };

/** 程序化生成城市白模（围绕 CITY 展开），供风场叠加演示 */
function addCityBuildings() {
  let seed = 42;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const instances: Cesium.GeometryInstance[] = [];
  for (let bx = -1; bx <= 1; bx++) {
    for (let by = -1; by <= 1; by++) {
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
          if (rnd() < 0.3) continue;
          const distC = Math.hypot(i - 3.5, j - 3.5);
          const isCore = bx === 0 && by === 0;
          const height = 25 + rnd() * (isCore ? 280 : 170) * (1 - distC / 9) + (rnd() < 0.12 ? rnd() * 160 : 0);
          const lon = CITY.lon + bx * 0.013 + (i - 3.5) * 0.0013 + (rnd() - 0.5) * 0.0004;
          const lat = CITY.lat + by * 0.012 + (j - 3.5) * 0.0012 + (rnd() - 0.5) * 0.0004;
          const position = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
          const mm = Cesium.Transforms.eastNorthUpToFixedFrame(position);
          Cesium.Matrix4.multiplyByTranslation(mm, new Cesium.Cartesian3(0, 0, height / 2), mm);
          const shade = 0.72 + rnd() * 0.22;
          instances.push(new Cesium.GeometryInstance({
            geometry: Cesium.BoxGeometry.fromDimensions({ dimensions: new Cesium.Cartesian3(42 + rnd() * 45, 42 + rnd() * 45, height) }),
            modelMatrix: mm,
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(new Cesium.Color(shade * 0.92, shade * 0.95, shade, 1)) },
          }));
        }
      }
    }
  }
  viewer.scene.primitives.add(new Cesium.Primitive({
    geometryInstances: instances,
    appearance: new Cesium.PerInstanceColorAppearance({ closed: true, translucent: false }),
    asynchronous: false,
  }));
}

/** Open-Meteo 气压层网格 → 箭头图层（方法 2：连续方程反算 w）。
 *  用法：example 页加 ?src=openmeteo 访问，自动请求巨港（Palembang）周边 5×5×5 层网格。 */
async function buildFromOpenMeteo(status: HTMLElement, params: URLSearchParams) {
  // 围绕项目演示城市（巨港 Palembang）生成 5×5 规则网格，一次性多点请求
  const lats: number[] = [];
  const lons: number[] = [];
  for (let la = CITY.lat - 0.2; la <= CITY.lat + 0.2001; la += 0.1) lats.push(+la.toFixed(4));
  for (let lo = CITY.lon - 0.2; lo <= CITY.lon + 0.2001; lo += 0.1) lons.push(+lo.toFixed(4));
  const pairedLat: number[] = [];
  const pairedLon: number[] = [];
  for (const la of lats) for (const lo of lons) { pairedLat.push(la); pairedLon.push(lo); }

  const lv = [1000, 925, 850, 700, 500]; // hPa
  const vars: string[] = [];
  for (const L of lv) {
    vars.push(`wind_speed_${L}hPa`, `wind_direction_${L}hPa`, `temperature_${L}hPa`, `geopotential_height_${L}hPa`);
  }
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${pairedLat.join(",")}&longitude=${pairedLon.join(",")}` +
    `&hourly=${vars.join(",")}&wind_speed_unit=ms&forecast_days=1`;

  status.textContent = "正在从 Open-Meteo 获取气压层网格…";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const json = await res.json();

  const windData = fromOpenMeteo({ levels: lv, response: json, windSpeedUnit: "ms" });
  layer = new WindArrowLayer(viewer, windData, {
    arrowCount: 16384,
    arrowLengthPx: 26,
    flowScale: 1500,
    maxLife: 900,
    trail: 1.5, // 已反算 w，箭头带俯仰角，彗尾更出彩
    heightOffset: 300, // 最低层约 0~100m，抬高让风场整体浮在城市白模之上
  });
  (window as unknown as Record<string, unknown>).windArrowLayer = layer;
  layer.zoomTo(0);
  bindControls();

  // 与本地数据分支一致：叠加同一座城市白模，并支持 ?cam=city / ?z= 调试
  addCityBuildings();
  if (params.get("cam") === "city") {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(CITY.lon, CITY.lat - 0.022, 1700),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
    });
  }
  const urlZ = params.get("z");
  if (urlZ !== null && urlZ !== "") layer.heightLevelValue = Number(urlZ);

  status.textContent =
    `Open-Meteo · 箭头 16384 · 网格 ${windData.nx}×${windData.ny}×${windData.nz}` +
    ` · 层高 ${windData.levels[0].toFixed(0)}~${windData.levels[windData.levels.length - 1].toFixed(0)}m`;
}

async function main() {
  const status = document.getElementById("status")!;
  const params = new URLSearchParams(location.search);
  try {
    if (params.get("src") === "openmeteo") {
      await buildFromOpenMeteo(status, params);
      return;
    }
    const res = await fetch("./data/wind_3d.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    // JSON 里是普通数组，转为 Float32Array 符合 WindData3D 契约
    const windData: WindData3D = normalizeWindData({
      u: { array: raw.u.array }, v: { array: raw.v.array }, w: { array: raw.w.array },
      nx: raw.nx, ny: raw.ny, nz: raw.nz,
      bounds: raw.bounds, levels: raw.levels,
    });

    layer = new WindArrowLayer(viewer, windData, {
      arrowCount: 16384,
      arrowLengthPx: 26,
      arrowScale: 1,
      flowScale: 1500,
      maxLife: 900,
      heightScale: 1,
      // 数据最低层 500m，城市白模最高 ~280m → 整体下沉 500m 让风场贴近地面/白模
      heightOffset: -500,
      // 彗尾流线：杆尾沿来风反方向延长并渐隐，呈现风"掠过"的拖尾感
      trail: 2.5,
    });
    (window as unknown as Record<string, unknown>).windArrowLayer = layer;
    layer.zoomTo(0);
    bindControls();

    // 与 Open-Meteo 分支一致：叠加同一座城市白模（巨港 Palembang）
    addCityBuildings();

    if (params.get("cam") === "city") {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(CITY.lon, CITY.lat - 0.022, 1700),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
      });
    }
    const urlZ = params.get("z");
    if (urlZ !== null && urlZ !== "") {
      layer.heightLevelValue = Number(urlZ);
    }

    status.textContent = `箭头数 16384 · 网格 ${windData.nx}×${windData.ny}×${windData.nz} · 层高 ${windData.levels[0]}~${windData.levels[windData.levels.length - 1]}m`;
  } catch (err) {
    console.error(err);
    status.textContent = `加载失败：${(err as Error).message}`;
  }
}

main();
