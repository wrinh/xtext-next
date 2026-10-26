/**
 * MoonBit WASM 引擎加载器
 *
 * 加载 xtext_core.wasm（wasm-gc + js-string builtins），fetch dict.bin，
 * base64 编码后送入引擎。对外暴露与旧 DictEngine 相同的查询接口。
 */

export interface WasmExports {
  load_dict(b64: string): number;
  record_count(): number;
  search_z(query: string): string;
  search_exact(query: string): string;
  search_prefix(query: string): string;
  search_contains(field: number, query: string): string;
  search_domain_prefix(query: string): string;
  search_meaning(query: string): string;
  get_json(idx: number): string;
}

let wasmPromise: Promise<WasmExports> | null = null;

async function instantiate(): Promise<WasmExports> {
  const [wasmResp] = await Promise.all([
    fetch('assets/xtext_core.wasm'),
  ]);
  if (!wasmResp.ok) throw new Error(`WASM 加载失败: ${wasmResp.status}`);
  const bytes = await wasmResp.arrayBuffer();

  const stringImports = new Proxy({}, {
    get: (_, name) => (typeof name === 'string' ? name : ''),
  }) as WebAssembly.ModuleImports;

  // WebAssembly.instantiate 的第三参数（compile options）是较新的 API，TS 尚未收录
  const instantiateWithBuiltins = WebAssembly.instantiate as unknown as (
    bytes: ArrayBuffer,
    imports: WebAssembly.Imports,
    compileOptions?: { builtins?: string[] },
  ) => Promise<WebAssembly.WebAssemblyInstantiatedSource>;

  const { instance } = await instantiateWithBuiltins(
    bytes,
    { _: stringImports },
    { builtins: ['js-string'] },
  );
  return instance.exports as unknown as WasmExports;
}

export function loadWasm(): Promise<WasmExports> {
  if (!wasmPromise) wasmPromise = instantiate();
  return wasmPromise;
}

/** 把 ArrayBuffer 转 base64（分块避免栈溢出） */
export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface WasmDictHandle {
  exports: WasmExports;
  count: number;
}
