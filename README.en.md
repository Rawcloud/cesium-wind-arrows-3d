> 🇨🇳 [中文文档](./README.md) · English below

# cesium-wind-arrows-3d

A WebGL2-based **3D wind-field arrow layer for CesiumJS**: a 3D arrow field driven by multi-level `(u, v, w)` wind data, implemented with GPGPU and **zero per-frame CPU work**.

The data contract is fully compatible with [cesium-wind-layer-3d](https://www.npmjs.com/package/cesium-wind-layer-3d) (the streamline-trail form) and the two can be used interchangeably — the same data, two visual forms.

## Features

- Native WebGL2 3D texture (`sampler3D`) stores the wind field with hardware trilinear interpolation
- GPU particle advection (Runge-Kutta 2) with anchor drifting + out-of-bounds/lifetime respawn for constant coverage density
- 3D arrow skinning: the vertex shader samples anchors and wind direction to assemble geometry; **wind direction includes the w component, so arrows naturally pitch** (vertical-flow visualization)
- Size adapts to camera height (constant screen pixels), frame-rate independent
- Height-level lock: one-click switch to any normalized height level (interactions like `?z=0.9` are implemented by the host app)
- Wind-speed color-band mapping, display-range filtering, NaN/missing-value guards
- Runtime data swap, parameter tuning, and show/hide
- "Guaranteed sow bounds" and height offset to fit ground / city-building scenarios

## Installation

```bash
npm install cesium-wind-arrows-3d
```

`cesium` (`^1.142.0`) is a peer dependency and must be installed in the consuming project.

Type declarations ship with the package (`dist/types`), so TypeScript projects work out of the box — no extra `@types` needed.

**Install / debug from a local package:**

```bash
# Install the built tarball directly
npm install ../cesium-wind-arrows-3d/cesium-wind-arrows-3d-0.1.8.tgz

# Or symlink to the source (rebuild after editing lib code; no repeated packing)
cd cesium-wind-arrows-3d && npm link
# In the consuming project:
npm link cesium-wind-arrows-3d
```

## Quick Start

```ts
import * as Cesium from "cesium";
import { WindArrowLayer } from "cesium-wind-arrows-3d";

const viewer = new Cesium.Viewer("container");

const windData = {
  u: { array: uArray },   // Float32Array(nx*ny*nz), eastward wind speed m/s
  v: { array: vArray },   // northward
  w: { array: wArray },   // vertical (positive upward)
  nx, ny, nz,
  bounds: { west, south, east, north },   // data extent (degrees)
  levels: [500, 1500, 3000, 5500],        // altitude per level (meters, ascending)
};

const layer = new WindArrowLayer(viewer, windData, {
  arrowCount: 16384,
  arrowLengthPx: 26,
  colors: ["rgb(24,78,165)", "rgb(64,196,198)", "rgb(248,216,90)", "rgb(210,48,60)"],
});

layer.zoomTo(2);
```

Array layout: `index = (z * ny + y) * nx + x`, with x=longitude (west→east), y=latitude (south→north), z=level (low→high). Plain arrays are auto-converted to `Float32Array` via `normalizeWindData`.

## Options

| Field | Default | Description |
|---|---|---|
| `arrowCount` | `16384` | Total arrow count (rounded to a size² texture layout) |
| `arrowLengthPx` | `26` | Arrow length in screen pixels (world size adapts to camera height) |
| `arrowScale` | `1` | Global arrow-length scale |
| `flowScale` | `1500` | Time acceleration factor for anchor drifting (real wind at 1s/s is too slow to see; visualization needs speed-up) |
| `maxLife` | `900` | Anchor lifetime (frames), respawns on expiry |
| `colors` | blue-cyan-yellow-red band | CSS color array (low→high wind speed) |
| `domain` | data magnitude range | Color-band mapping domain `[min, max]` (m/s) |
| `displayRange` | no clipping | Display range `[min, max]`; arrows outside are hidden |
| `heightLevel` | `null` | `null` = evenly distributed across all levels; `0~1` locks to that normalized height level |
| `heightScale` | `1` | Height stretch factor (applied after sampling, scales only world height) |
| `heightOffset` | `0` | Height offset applied to the whole field (meters, altitude), added on top of world height:<br>world height = `mix(levels[0], levels[nz-1], zNorm) * heightScale + heightOffset`<br>Used to lift/sink the whole field to hug the ground or city buildings (see below) |
| `sowBounds` | none | Guaranteed sow bounds (`{west,south,east,north}`, degrees). Actual sow bounds = viewport ∪ guaranteed bounds (then ∩ data bounds), ensuring fixed-area coverage at all times |
| `trail` | `0` | Trail length (multiple of arrow base length). `0` = no trail; `>0` extends the shaft tail backward along incoming wind into a fading comet-trail streamline (tapering tip + fade to 0), giving a "wind sweeping past" streamline feel; typical `1.5~3` |
| `dynamic` | `true` | Whether anchors drift (false = static) |
| `flipY` | `false` | Flip the data JSON array row order |

## Fitting the Ground / City Buildings

With the default `heightScale=1`, the lowest wind level (e.g. 500m) floats above city buildings (roof ~280m), looking "detached". Use the two techniques together:

1. **Sink the whole field** — use `heightOffset` to lift/lower the field by its level altitude so the lowest level hugs the ground:

   ```ts
   // Lowest data level 500m, city buildings up to ~280m → sink 500m so the field hugs the surface
   const layer = new WindArrowLayer(viewer, windData, {
     heightOffset: -500,   // unit: meters (altitude)
   });
   ```

   > Note: only the world height is offset; `zNorm` sampling is unchanged, so wind is still taken from the real data level.

2. **Guaranteed coverage** — when looking down from low altitude, the viewport may cover only part of the city, leaving arrows floating over a local patch. Use `sowBounds` to frame the target city so arrows always cover it:

   ```ts
   const layer = new WindArrowLayer(viewer, windData, {
     sowBounds: { west: 104.70, south: -3.05, east: 104.85, north: -2.90 }, // city lon/lat box
   });
   ```

The sow bounds auto-follow the camera (ground pick point at center + pixel-size extrapolation), keeping density stable on zoom — no dense clumps or leftover high-density bands from rapid zooming.

## API

| Member | Description |
|---|---|
| `show` | Read/write property, controls visibility |
| `heightLevelValue` | Read/write property; `null` = all levels; `0~1` locks to a normalized height level |
| `updateWindData(data)` | Replace wind data at runtime (rebuilds the 3D texture; arrow system preserved) |
| `updateOptions(options)` | Update parameters at runtime (shallow merge) |
| `zoomTo(duration?)` | Fly camera to the data extent; `duration` defaults to `0` (instant) |
| `destroy()` | Release GPU resources, returns `this` |
| `isDestroyed()` | Whether already destroyed |

```ts
layer.show = false;                              // hide
layer.heightLevelValue = 0.9;                    // lock to 90% height level
layer.updateOptions({ arrowLengthPx: 40 });      // tune params at runtime
layer.updateWindData(otherWindData);             // swap data
```

## Browser Requirements

- WebGL2 (CesiumJS 1.104+ enables it by default)
- `EXT_color_buffer_float` floating-point color-buffer extension

## Local Development / Build

```bash
npm install
npm run dev:example   # start the example page (http://localhost:3008), with procedural city buildings
npm test              # unit tests (vitest)
npm run build         # build dist (with .d.ts type declarations)
npm pack              # produce cesium-wind-arrows-3d-<version>.tgz
```

Example page URL params: `?cam=city` enters a low-altitude city view; `?z=0.9` locks the height level on startup.

## Where Does the Wind Data Come From

- **Out of the box**: the `cesium-wind-layer-3d` repo's example ships `wind_3d.json` (3D wind field over Indonesia, MIT)
- **Free, no API key**: [Open-Meteo](https://open-meteo.com/) pressure-level API (wind speed + direction → convert to u/v; no w)
- **Full w component**: ERA5 (Copernicus CDS) or NOAA GFS GRIB2 — note pressure vertical velocity (Pa/s) must be converted to geometric m/s

## Integrating from Open-Meteo (no w data)

The Open-Meteo pressure-level API provides only u/v (wind speed + direction), not vertical velocity w. This package provides `fromOpenMeteo()`, which **recovers w from the continuity equation** (method 2): `∂u/∂x + ∂v/∂y + ∂ω/∂p = 0` is integrated downward from the top (ω=0) to obtain the pressure-coordinate vertical velocity ω, then converted to geometric vertical velocity `w = -ω·R·T/(g·p)`. Arrows thus carry a real pitch angle, giving the strongest 3D feel.

Note: Open-Meteo is a **single-point API** with no bounding-box parameter. To get a spatial grid, concatenate all `(lat,lon)` combinations of a lon/lat grid with commas in one request (e.g. 5×5 = 25 points); `fromOpenMeteo` then rebuilds the regular grid from the response by unique lat/lon. The request must include `wind_speed` / `wind_direction` / `temperature` / `geopotential_height` for each pressure level (variable names like `wind_speed_850hPa`).

```ts
import { fromOpenMeteo } from "cesium-wind-arrows-3d";

const lv = [1000, 925, 850, 700, 500]; // hPa, sorted by altitude internally
const vars = lv.flatMap((L) => [
  `wind_speed_${L}hPa`, `wind_direction_${L}hPa`,
  `temperature_${L}hPa`, `geopotential_height_${L}hPa`,
]);
const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
  `&hourly=${vars.join(",")}&wind_speed_unit=ms&forecast_days=1`;

const windData = fromOpenMeteo({ levels: lv, response: await (await fetch(url)).json(), windSpeedUnit: "ms" });
// windData is passed straight to new WindArrowLayer(viewer, windData, {...})
```

Append `?src=openmeteo` to the example page to one-click pull a 5×5×5-level grid demo around Palembang (w recovered + comet trail), overlaid on the same city's buildings.

## License

MIT
