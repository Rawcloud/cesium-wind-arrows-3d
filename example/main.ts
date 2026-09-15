import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { WindArrowLayer, normalizeWindData, type WindData3D } from "../src";

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

async function main() {
  const status = document.getElementById("status")!;
  try {
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

    // 城市白模（程序化生成）——城市必须在数据 bounds 内，选巨港（Palembang）
    const CITY = { lon: 104.775, lat: -2.976 };
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

    const params = new URLSearchParams(location.search);
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
