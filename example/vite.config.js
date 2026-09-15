import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// 示例页独立构建：root=example，从上级 node_modules 取 Cesium 静态资源
export default defineConfig({
  root: "example",
  base: "./",
  define: {
    CESIUM_BASE_URL: JSON.stringify("./cesium/"),
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: "../node_modules/cesium/Build/Cesium/Workers", dest: "cesium" },
        { src: "../node_modules/cesium/Build/Cesium/ThirdParty", dest: "cesium" },
        { src: "../node_modules/cesium/Build/Cesium/Assets", dest: "cesium" },
        { src: "../node_modules/cesium/Build/Cesium/Widgets", dest: "cesium" },
      ],
    }),
  ],
  server: { port: 3008 },
});
