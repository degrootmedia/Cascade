/**
 * Minimal CEL subset evaluator for the `rules` a Higgsfield `model get` reply
 * carries (e.g. `params.mode != "fast" || !(params.resolution in ["1080p","4k"])`).
 * Supports literals, `params.x`, `size()`, lists, == != < <= > >=, in, + - ,
 * && || !, ?: and parentheses. Anything else throws; callers treat a throw as
 * "rule unknown → allow".
 */
type V = string | number | boolean | null | V[];
type Tok = { t: "n" | "s" | "id" | "op"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z_][\w.]*)|(&&|\|\||==|!=|<=|>=|[<>!+\-?:()[\],]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`cel: bad token at ${i}`);
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "n", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "s", v: m[2].replace(/\\(.)/g, "$1") });
    else if (m[3] !== undefined) out.push({ t: "s", v: m[3].replace(/\\(.)/g, "$1") });
    else if (m[4] !== undefined) out.push({ t: "id", v: m[4] });
    else out.push({ t: "op", v: m[5] });
  }
  return out;
}

export function evalCel(src: string, params: Record<string, unknown>): V {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => toks[p]?.t === "op" && toks[p].v === v;
  const eat = (v: string) => { if (!isOp(v)) throw new Error(`cel: expected ${v}`); p++; };
  const norm = (x: unknown): V => (x === undefined ? null : (x as V));

  function ternary(): V {
    const c = or();
    if (isOp("?")) { p++; const a = ternary(); eat(":"); const b = ternary(); return c ? a : b; }
    return c;
  }
  function or(): V { let l = and(); while (isOp("||")) { p++; const r = and(); l = !!l || !!r; } return l; }
  function and(): V { let l = cmp(); while (isOp("&&")) { p++; const r = cmp(); l = !!l && !!r; } return l; }
  function cmp(): V {
    const l = add();
    const t = peek();
    if (t?.t === "id" && t.v === "in") { p++; const r = add(); return Array.isArray(r) && r.some((x) => x === l); }
    if (t?.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      p++;
      const r = add();
      switch (t.v) {
        case "==": return l === r;
        case "!=": return l !== r;
        case "<": return (l as number) < (r as number);
        case "<=": return (l as number) <= (r as number);
        case ">": return (l as number) > (r as number);
        default: return (l as number) >= (r as number);
      }
    }
    return l;
  }
  function add(): V {
    let l = unary();
    while (isOp("+") || isOp("-")) {
      const op = toks[p++].v;
      const r = unary();
      if (Array.isArray(l) && Array.isArray(r)) l = [...l, ...r];
      else if (op === "+") l = typeof l === "string" ? l + String(r) : (l as number) + (r as number);
      else l = (l as number) - (r as number);
    }
    return l;
  }
  function unary(): V {
    if (isOp("!")) { p++; return !unary(); }
    if (isOp("-")) { p++; return -(unary() as number); }
    return primary();
  }
  function primary(): V {
    const t = toks[p++];
    if (!t) throw new Error("cel: unexpected end");
    if (t.t === "n") return Number(t.v);
    if (t.t === "s") return t.v;
    if (t.t === "op") {
      if (t.v === "(") { const v = ternary(); eat(")"); return v; }
      if (t.v === "[") {
        const items: V[] = [];
        while (!isOp("]")) { items.push(ternary()); if (isOp(",")) p++; else break; }
        eat("]");
        return items;
      }
      throw new Error(`cel: unexpected ${t.v}`);
    }
    if (t.v === "true") return true;
    if (t.v === "false") return false;
    if (t.v === "null") return null;
    if (t.v === "size" && isOp("(")) {
      p++; const a = ternary(); eat(")");
      return Array.isArray(a) ? a.length : typeof a === "string" ? a.length : 0;
    }
    if (t.v.startsWith("params.")) {
      const v = params[t.v.slice(7)];
      return norm(v);
    }
    throw new Error(`cel: unknown identifier ${t.v}`);
  }

  const v = ternary();
  if (p < toks.length) throw new Error("cel: trailing input");
  return v;
}

/** True when every rule holds (or can't be evaluated). */
export function rulesAllow(rules: { cel: string }[], params: Record<string, unknown>): boolean {
  for (const r of rules) {
    try {
      if (evalCel(r.cel, params) === false) return false;
    } catch { /* unknown construct → allow */ }
  }
  return true;
}

/** Resolutions from `ranked` (any order) that satisfy the rules given the
 *  other params; falls back to all of them if none do. */
export function resolutionsAllowedByRules(
  rules: { cel: string }[],
  params: Record<string, unknown>,
  resolutions: string[]
): string[] {
  const ok = resolutions.filter((r) => rulesAllow(rules, { ...params, resolution: r }));
  return ok.length ? ok : resolutions;
}
