// lzma-wasm 类型声明（包的 dist/index.d.ts 引用缺失的 pkg 路径，这里补声明）
declare module 'lzma-wasm' {
  export interface CompressOptions {
    format?: 'xz' | 'lzma' | 'lzip';
    level?: number;
    memoryLimit?: number;
  }
  export interface DecompressOptions {
    size?: number;
    memoryLimit?: number;
  }
  export function initWasm(): Promise<unknown>;
  export function initWasmSync(): unknown;
  export function compress(data: Uint8Array, options?: CompressOptions): Uint8Array;
  export function decompress(data: Uint8Array, options?: DecompressOptions): Uint8Array;
}
