// ---------------------------------------------------------------------------
// FO-REQ-0030 (BL-201): a runtime test checks a template's graph against the runtime's own node definitions (`/object_info`),
// statically, without queueing anything:
//   required_missing  an input in the node's `input.required` that the graph does not set (by value or link) and no template
//                     parameter fills at job time
//   unknown_input     an input the node does not declare (required / optional / hidden) -- a warning: ComfyUI ignores it
//   bad_value         a fixed value outside a list (COMBO), or of the wrong type for INT / FLOAT / BOOLEAN
//   out_of_range      an INT / FLOAT fixed value outside the declared min / max
// Linked inputs and inputs a parameter fills are never value-checked. A list of model or media files is not checked here (the
// pod's list may not yet show the volume; `modelsMissing` covers model files).
// `/object_info` shape (ComfyUI server routes): { <class_type>: { input: { required: { name: [TYPE | [values], {opts}] },
// optional: {...}, hidden: {...} }, ... } }; newer builds also write a list as ["COMBO", { options: [values] }].
// ---------------------------------------------------------------------------

export type GraphInputProblem = "required_missing" | "unknown_input" | "bad_value" | "out_of_range";

export type GraphInputIssue = {
  nodeId: string;
  classType: string;
  input: string;
  problem: GraphInputProblem;
  allowed?: unknown;
};

/** Only the input definitions of each node type -- what the check needs from `/object_info`. */
export type NodeInputInfo = Record<string, { required: Record<string, unknown>; optional: Record<string, unknown>; hidden: Record<string, unknown> }>;

const FILE_VALUE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx|json|yaml|png|jpe?g|webp|gif|mp4|webm|mov|wav|mp3|flac|ogg)$/i;
const MAX_ALLOWED_SHOWN = 50;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The input definitions of every node type in an `/object_info` answer (the rest -- outputs, descriptions -- is dropped). */
export function compactNodeInfo(objectInfo: unknown): NodeInputInfo {
  const out: NodeInputInfo = {};
  for (const [classType, info] of Object.entries(record(objectInfo))) {
    const input = record(record(info).input);
    out[classType] = { required: record(input.required), optional: record(input.optional), hidden: record(input.hidden) };
  }
  return out;
}

/** A list input's allowed values, or null when the input is not a list. */
function listOf(spec: unknown[]): unknown[] | null {
  const [type, opts] = spec;
  if (Array.isArray(type)) return type;
  if (type === "COMBO" && Array.isArray(record(opts).options)) return record(opts).options as unknown[];
  return null;
}

function valueProblem(spec: unknown, value: unknown): { problem: GraphInputProblem; allowed?: unknown } | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  const list = listOf(spec);
  if (list) {
    if (list.includes(value)) return null;
    // A file list (models, inputs) is the pod's view of its disk, not a contract of the node.
    if ((typeof value === "string" && FILE_VALUE.test(value)) || list.some((v) => typeof v === "string" && FILE_VALUE.test(v))) return null;
    return { problem: "bad_value", allowed: list.slice(0, MAX_ALLOWED_SHOWN) };
  }
  const [type, rawOpts] = spec;
  const opts = record(rawOpts);
  if (type === "INT" || type === "FLOAT") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "INT" && !Number.isInteger(value))) return { problem: "bad_value", allowed: type };
    const min = typeof opts.min === "number" ? opts.min : null;
    const max = typeof opts.max === "number" ? opts.max : null;
    if ((min !== null && value < min) || (max !== null && value > max)) return { problem: "out_of_range", allowed: { min, max } };
    return null;
  }
  if (type === "BOOLEAN" && typeof value !== "boolean") return { problem: "bad_value", allowed: "BOOLEAN" };
  return null;
}

/**
 * Every input problem of an API-format graph against `info`. `parameterInputs` = "nodeId.input" pairs a template parameter fills at
 * job time (counted as set, never value-checked). A node type `info` lacks is skipped (it is reported as `missing` elsewhere).
 */
export function checkGraphInputs(workflowJson: string, info: NodeInputInfo, parameterInputs: ReadonlySet<string> = new Set()): GraphInputIssue[] {
  let graph: unknown;
  try {
    graph = JSON.parse(workflowJson);
  } catch {
    return [];
  }
  const issues: GraphInputIssue[] = [];
  for (const [nodeId, rawNode] of Object.entries(record(graph))) {
    const node = record(rawNode);
    const classType = typeof node.class_type === "string" ? node.class_type : null;
    const def = classType ? info[classType] : undefined;
    if (!classType || !def) continue;
    const inputs = record(node.inputs);
    const filled = (name: string) => parameterInputs.has(`${nodeId}.${name}`);
    for (const name of Object.keys(def.required)) {
      if (!(name in inputs) && !filled(name)) issues.push({ nodeId, classType, input: name, problem: "required_missing" });
    }
    for (const [name, value] of Object.entries(inputs)) {
      const spec = def.required[name] ?? def.optional[name];
      if (spec === undefined) {
        if (!(name in def.hidden)) issues.push({ nodeId, classType, input: name, problem: "unknown_input" });
        continue;
      }
      if (Array.isArray(value) || filled(name)) continue; // a link, or a value the job sets
      const problem = valueProblem(spec, value);
      if (problem) issues.push({ nodeId, classType, input: name, ...problem });
    }
  }
  return issues;
}

/** Issues that make a template fail (everything but the `unknown_input` warning). */
export function blockingIssues(issues: readonly GraphInputIssue[]): GraphInputIssue[] {
  return issues.filter((i) => i.problem !== "unknown_input");
}
