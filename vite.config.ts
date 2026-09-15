import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "WindArrows3d",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "index.js" : "index.umd.cjs"),
    },
    rollupOptions: {
      external: ["cesium"],
      output: {
        globals: { cesium: "Cesium" },
      },
    },
    sourcemap: false,
    minify: "esbuild",
  },
  plugins: [
    dts({
      entryRoot: "src",
      outDir: "dist/types",
      include: ["src"],
      // 对类型诊断宽松：本包用到 Cesium 内部 WebGL API（Texture3D/DrawCommand/ShaderSource 等），
      // 不同 cesium 版本公开声明可能缺失，跳过诊断可保证 .d.ts 始终能生成、可稳定发包
      skipDiagnostics: true,
    }),
  ],
});
