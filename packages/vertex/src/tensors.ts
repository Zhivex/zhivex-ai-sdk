import { ConfigurationError } from "@zhivex-ai/core/provider";

export type VertexTensorDataType = "DATA_TYPE_UNSPECIFIED" | "BOOL" | "STRING" | "FLOAT" | "DOUBLE" | "INT8" | "INT16" | "INT32" | "INT64" | "UINT8" | "UINT16" | "UINT32" | "UINT64";
type ProtoFloat = number | "NaN" | "Infinity" | "-Infinity";
/** Native REST Tensor. 64-bit integers stay strings to preserve precision. */
export interface VertexTensor {
  dtype?: VertexTensorDataType;
  shape?: string[];
  boolVal?: boolean[];
  stringVal?: string[];
  bytesVal?: string[];
  floatVal?: ProtoFloat[];
  doubleVal?: ProtoFloat[];
  intVal?: number[];
  int64Val?: string[];
  uintVal?: number[];
  uint64Val?: string[];
  listVal?: VertexTensor[];
  structVal?: Record<string, VertexTensor>;
  tensorVal?: string;
}
const types = new Set(["DATA_TYPE_UNSPECIFIED", "BOOL", "STRING", "FLOAT", "DOUBLE", "INT8", "INT16", "INT32", "INT64", "UINT8", "UINT16", "UINT32", "UINT64"]);
const integer64 = (value: unknown, unsigned = false) => {
  if (typeof value !== "string" || value.length > 20 || !/^-?\d+$/.test(value)) return false;
  const number = BigInt(value);
  return unsigned ? number >= 0n && number <= 18446744073709551615n : number >= -9223372036854775808n && number <= 9223372036854775807n;
};
const protoFloat = (v: unknown) => typeof v === "number" ? Number.isFinite(v) : ["NaN", "Infinity", "-Infinity"].includes(v as string);
const base64 = (v: unknown) => typeof v === "string" && /^(?:[A-Za-z0-9+/_-]{4})*(?:[A-Za-z0-9+/_-]{2}(?:==)?|[A-Za-z0-9+/_-]{3}=?|)?$/.test(v);
export function assertVertexTensor(value: unknown, depth = 0): asserts value is VertexTensor {
  const invalid = () => { throw new ConfigurationError("Invalid Vertex REST Tensor representation."); };
  if (depth > 32 || !value || typeof value !== "object" || Array.isArray(value)) invalid();
  const tensor = value as Record<string, unknown>;
  if (tensor.dtype !== undefined && !types.has(tensor.dtype as string)) invalid();
  const arrays: Record<string, (v: unknown) => boolean> = {
    shape: v => integer64(v), boolVal: v => typeof v === "boolean", stringVal: v => typeof v === "string", bytesVal: base64,
    floatVal: protoFloat, doubleVal: protoFloat,
    intVal: v => typeof v === "number" && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647,
    uintVal: v => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4294967295,
    int64Val: v => integer64(v), uint64Val: v => integer64(v, true)
  };
  for (const [key, valid] of Object.entries(arrays)) if (tensor[key] !== undefined && (!Array.isArray(tensor[key]) || !(tensor[key] as unknown[]).every(valid))) invalid();
  if (tensor.tensorVal !== undefined && !base64(tensor.tensorVal)) invalid();
  if (tensor.listVal !== undefined) {
    if (!Array.isArray(tensor.listVal)) invalid();
    for (const child of tensor.listVal as unknown[]) assertVertexTensor(child, depth + 1);
  }
  if (tensor.structVal !== undefined) {
    if (!tensor.structVal || typeof tensor.structVal !== "object" || Array.isArray(tensor.structVal)) invalid();
    for (const child of Object.values(tensor.structVal as object)) assertVertexTensor(child, depth + 1);
  }
  const scalarFields = Object.keys(arrays).filter(key => key !== "shape" && tensor[key] !== undefined);
  if (scalarFields.length > 1) invalid();
  const allowed: Record<string, string[]> = { BOOL: ["boolVal"], STRING: ["stringVal", "bytesVal"], FLOAT: ["floatVal"], DOUBLE: ["doubleVal"], INT8: ["intVal"], INT16: ["intVal"], INT32: ["intVal"], INT64: ["int64Val"], UINT8: ["uintVal"], UINT16: ["uintVal"], UINT32: ["uintVal"], UINT64: ["uint64Val"] };
  if (scalarFields.length && tensor.dtype !== undefined && !allowed[tensor.dtype as string]?.includes(scalarFields[0])) invalid();
}
