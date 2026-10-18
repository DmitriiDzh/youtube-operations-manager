// ---------------------------------------------------------------------------
// FO-REQ-0030 (BL-201): a runtime test checks a template's graph against the runtime's own node definitions (`/object_info`),
// statically, without queueing anything:
//   required_missing  an input in the node's `input.required` that the graph does not set (by value or link) and no template
//                     parameter fills at job time
//   unknown_input     an input the node does not declare (required / optional / hidden) -- a warning: ComfyUI ignores it
//   bad_value         a fixed value outside a list (COMBO), or an INT / FLOAT value ComfyUI cannot convert to a number
//   out_of_range      an INT / FLOAT value (after ComfyUI's own int()/float() conversion) outside the declared min / max
// Never stricter than ComfyUI's own `validate_inputs` (review, owner msg 3044: our checks must not get in the Operator's way):
// "20" is a valid INT (converted), any BOOLEAN value is accepted (bool()), a V3 dynamic input set as sub-keys (`images.image0`)
// counts as set. Linked inputs and inputs a parameter fills are never value-checked. A list of files (models, media, fonts, folders)
// is not checked: the pod's list may not yet show the volume (`modelsMissing` covers model files).
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

const FILE_VALUE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx|json|yaml|yml|txt|csv|cube|ttf|otf|png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov|mkv|avi|wav|mp3|flac|ogg|m4a|opus|aac)$/i;
/** LoadImage-style annotations ComfyUI accepts on a file name: `x.png [output]`. */
const FILE_ANNOTATION = / \[(input|output|temp)\]$/;

/** A file-like value: a known extension (after an annotation), or a path. */
function looksLikeFile(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const name = value.replace(FILE_ANNOTATION, "");
  return FILE_VALUE.test(name) || name.includes("/") || name.includes("\\");
}
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
    // A file list (models, inputs, folders) is the pod's view of its disk, not a contract of the node; an empty list is one too.
    if (list.length === 0 || looksLikeFile(value) || list.some(looksLikeFile)) return null;
    return { problem: "bad_value", allowed: list.slice(0, MAX_ALLOWED_SHOWN) };
  }
  const [type, rawOpts] = spec;
  const opts = record(rawOpts);
  if (type === "INT" || type === "FLOAT") {
    // As ComfyUI: int(val) / float(val) -- a numeric string or a float for an INT is converted, not refused.
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (!Number.isFinite(number)) return { problem: "bad_value", allowed: type };
    const converted = type === "INT" ? Math.trunc(number) : number;
    const min = typeof opts.min === "number" ? opts.min : null;
    const max = typeof opts.max === "number" ? opts.max : null;
    if ((min !== null && converted < min) || (max !== null && converted > max)) return { problem: "out_of_range", allowed: { min, max } };
    return null;
  }
  // BOOLEAN: ComfyUI takes bool(val) of anything -- never refused.
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
    // A V3 dynamic input (Autogrow, DynamicCombo) is set in the graph as `<name>.<sub>` keys.
    const hasSubKeys = (name: string) => Object.keys(inputs).some((key) => key.startsWith(`${name}.`));
    for (const name of Object.keys(def.required)) {
      if (!(name in inputs) && !filled(name) && !hasSubKeys(name)) issues.push({ nodeId, classType, input: name, problem: "required_missing" });
    }
    for (const [name, value] of Object.entries(inputs)) {
      const spec = def.required[name] ?? def.optional[name];
      if (spec === undefined) {
        const parent = name.includes(".") ? name.slice(0, name.indexOf(".")) : null;
        const declared = parent !== null && (parent in def.required || parent in def.optional);
        if (!(name in def.hidden) && !declared) issues.push({ nodeId, classType, input: name, problem: "unknown_input" });
        continue;
      }
      if (value === null) continue; // an optional input left empty
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
