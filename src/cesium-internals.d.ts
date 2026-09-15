/* Cesium 内部 WebGL API 的最小环境声明。
 *
 * 本库在运行期通过 `Cesium.*` 直接使用一批 Cesium 的私有/底层 WebGL 类型
 * （Texture3D、DrawCommand、ComputeCommand、ShaderSource、VertexArray、
 * ShaderProgram、RenderState、Pass、Sampler、TextureWrap、BufferUsage 等，
 * 以及 Scene.context）。这些类型在 Cesium 的公开 TypeScript 声明中并未导出，
 * 因此在此做最小声明，仅供 `vite-plugin-dts` 类型检查与 .d.ts 生成通过。
 *
 * 仅声明本库实际用到的成员，不追求与 Cesium 运行时完全一致。
 */
declare module "cesium" {
  export class Texture {
    constructor(options?: any);
    destroy(): void;
  }

  export class Texture3D {
    constructor(options?: any);
    destroy(): void;
  }

  export class Sampler {
    constructor(options?: any);
  }

  export class ShaderSource {
    constructor(options?: any);
  }

  export class VertexArray {
    static fromGeometry(options?: any): VertexArray;
    destroy(): void;
  }

  export class ShaderProgram {
    static fromCache(options?: any): ShaderProgram;
    destroy(): void;
  }

  export class RenderState {
    static fromCache(options?: any): RenderState;
  }

  export class DrawCommand {
    constructor(options?: any);
    vertexArray?: any;
    shaderProgram?: any;
    [key: string]: any;
  }

  export class ComputeCommand {
    constructor(options?: any);
    outputTexture?: any;
    shaderProgram?: any;
    [key: string]: any;
  }

  export class FrameState {
    commandList: any[];
    [key: string]: any;
  }

  export enum TextureWrap {
    CLAMP_TO_EDGE,
    REPEAT,
    MIRRORED_REPEAT,
  }

  export enum BufferUsage {
    STATIC_DRAW,
    STREAM_DRAW,
    DYNAMIC_DRAW,
  }

  export enum Pass {
    OPAQUE,
    TRANSLUCENT,
    OVERLAY,
  }

  export interface Scene {
    context: any;
  }
}
