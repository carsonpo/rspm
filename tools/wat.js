// Minimal WAT → WASM assembler. Zero dependencies.
//
// Supports exactly the subset rspm's hand-written modules need: i32/i64 integer
// ops, locals, globals, one memory, active data segments, function imports and
// exports, structured control flow (plain and folded forms), and bulk
// memory.copy / memory.fill. No floats, tables, or multi-value block types.
// Anything outside the subset is a hard error, never a silent miscompile.
//
// Usage: node tools/wat.js in.wat out.wasm
//        import { assemble } from './wat.js'  → Uint8Array

const VALTYPE = { i32: 0x7f, i64: 0x7e };

const OPS = {
  unreachable: [0x00], nop: [0x01], return: [0x0f], drop: [0x1a], select: [0x1b],
  'memory.size': [0x3f, 0x00], 'memory.grow': [0x40, 0x00],
  'memory.copy': [0xfc, 0x0a, 0x00, 0x00], 'memory.fill': [0xfc, 0x0b, 0x00],
  'i32.wrap_i64': [0xa7], 'i64.extend_i32_s': [0xac], 'i64.extend_i32_u': [0xad],
  'i32.extend8_s': [0xc0], 'i32.extend16_s': [0xc1],
  'i64.extend8_s': [0xc2], 'i64.extend16_s': [0xc3], 'i64.extend32_s': [0xc4],
};
const CMP = ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u'];
const ARITH = ['clz', 'ctz', 'popcnt', 'add', 'sub', 'mul', 'div_s', 'div_u', 'rem_s', 'rem_u',
  'and', 'or', 'xor', 'shl', 'shr_s', 'shr_u', 'rotl', 'rotr'];
OPS['i32.eqz'] = [0x45]; CMP.forEach((n, i) => (OPS[`i32.${n}`] = [0x46 + i]));
OPS['i64.eqz'] = [0x50]; CMP.forEach((n, i) => (OPS[`i64.${n}`] = [0x51 + i]));
ARITH.forEach((n, i) => (OPS[`i32.${n}`] = [0x67 + i]));
ARITH.forEach((n, i) => (OPS[`i64.${n}`] = [0x79 + i]));

// name → [opcode, natural alignment (log2 bytes)]
const MEM = {
  'i32.load': [0x28, 2], 'i64.load': [0x29, 3],
  'i32.load8_s': [0x2c, 0], 'i32.load8_u': [0x2d, 0], 'i32.load16_s': [0x2e, 1], 'i32.load16_u': [0x2f, 1],
  'i64.load8_s': [0x30, 0], 'i64.load8_u': [0x31, 0], 'i64.load16_s': [0x32, 1], 'i64.load16_u': [0x33, 1],
  'i64.load32_s': [0x34, 2], 'i64.load32_u': [0x35, 2],
  'i32.store': [0x36, 2], 'i64.store': [0x37, 3], 'i32.store8': [0x3a, 0], 'i32.store16': [0x3b, 1],
  'i64.store8': [0x3c, 0], 'i64.store16': [0x3d, 1], 'i64.store32': [0x3e, 2],
};

class WatError extends Error {
  constructor(msg, node) { super(node?.line ? `line ${node.line}: ${msg}` : msg); }
}

// ── Tokenizer + S-expression parser ─────────────────────────────────────────

const utf8 = (s) => new TextEncoder().encode(s);

function parse(src) {
  let i = 0, line = 1;
  const root = [];
  const stack = [root];
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; }
    else if (/\s/.test(c)) i++;
    else if (c === ';' && src[i + 1] === ';') { while (i < src.length && src[i] !== '\n') i++; }
    else if (c === '(' && src[i + 1] === ';') {
      let depth = 1; i += 2;
      while (depth && i < src.length) {
        if (src[i] === '\n') line++;
        if (src[i] === '(' && src[i + 1] === ';') { depth++; i += 2; }
        else if (src[i] === ';' && src[i + 1] === ')') { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new WatError('unterminated block comment', { line });
    }
    else if (c === '(') { const list = []; list.line = line; stack.at(-1).push(list); stack.push(list); i++; }
    else if (c === ')') {
      if (stack.length === 1) throw new WatError('unexpected )', { line });
      stack.pop(); i++;
    }
    else if (c === '"') {
      const bytes = [];
      i++;
      while (src[i] !== '"') {
        if (i >= src.length) throw new WatError('unterminated string', { line });
        if (src[i] === '\\') {
          const e = src[i + 1];
          const simple = { n: 10, t: 9, r: 13, '\\': 92, "'": 39, '"': 34 };
          if (e in simple) { bytes.push(simple[e]); i += 2; }
          else if (e === 'u' && src[i + 2] === '{') {
            const end = src.indexOf('}', i);
            bytes.push(...utf8(String.fromCodePoint(parseInt(src.slice(i + 3, end), 16))));
            i = end + 1;
          }
          else if (/[0-9a-fA-F]{2}/.test(src.slice(i + 1, i + 3))) {
            bytes.push(parseInt(src.slice(i + 1, i + 3), 16)); i += 3;
          }
          else throw new WatError(`bad string escape \\${e}`, { line });
        } else {
          const cp = src.codePointAt(i);
          const ch = String.fromCodePoint(cp);
          bytes.push(...utf8(ch)); i += ch.length;
        }
      }
      i++;
      stack.at(-1).push({ str: new Uint8Array(bytes), line });
    }
    else {
      const start = i;
      while (i < src.length && !/[\s()";]/.test(src[i])) i++;
      stack.at(-1).push({ atom: src.slice(start, i), line });
    }
  }
  if (stack.length !== 1) throw new WatError('unclosed (', { line });
  return root;
}

const isList = (n) => Array.isArray(n);
const isAtom = (n, v) => n && !isList(n) && 'atom' in n && (v === undefined || n.atom === v);
const isId = (n) => isAtom(n) && n.atom.startsWith('$');
const head = (n) => (isList(n) && isAtom(n[0]) ? n[0].atom : null);

// ── Binary encoding ─────────────────────────────────────────────────────────

function uleb(n) {
  n = BigInt(n);
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function sleb(n) {
  n = BigInt(n);
  const out = [];
  for (;;) {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    if ((n === 0n && !(b & 0x40)) || (n === -1n && b & 0x40)) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

const vec = (items) => [...uleb(items.length), ...items.flat()];
const name = (bytes) => [...uleb(bytes.length), ...bytes];

// Integer literal → BigInt, wrapped to `bits` as a signed value.
function int(node, bits) {
  if (!isAtom(node)) throw new WatError('expected integer', node);
  let s = node.atom.replaceAll('_', '');
  let neg = false;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; s = s.slice(1); }
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(s)) throw new WatError(`bad integer ${node.atom}`, node);
  let v = BigInt(s);
  const max = 1n << BigInt(bits);
  if (v >= max || (neg && v > max >> 1n)) throw new WatError(`integer out of range for i${bits}: ${node.atom}`, node);
  if (neg) v = -v;
  return BigInt.asIntN(bits, v);
}

function u32(node) {
  const v = int(node, 33);
  if (v < 0n || v > 0xffffffffn) throw new WatError(`expected u32, got ${node.atom}`, node);
  return Number(v);
}

// ── Module assembly ─────────────────────────────────────────────────────────

export function assemble(src) {
  const top = parse(src);
  if (top.length !== 1 || head(top[0]) !== 'module') throw new WatError('expected a single (module ...)');
  const fields = top[0].slice(1);
  if (isId(fields[0])) fields.shift();

  const types = []; const typeKeys = new Map();
  const typeIndex = (params, results) => {
    const key = `${params}->${results}`;
    if (!typeKeys.has(key)) {
      typeKeys.set(key, types.length);
      types.push([0x60, ...vec(params.map((t) => [VALTYPE[t]])), ...vec(results.map((t) => [VALTYPE[t]]))]);
    }
    return typeKeys.get(key);
  };

  const funcNames = new Map(), globalNames = new Map();
  const imports = [], funcs = [], globals = [], exports = [], datas = [];
  let memory = null;

  const valtype = (n) => {
    if (!isAtom(n) || !(n.atom in VALTYPE)) throw new WatError(`unsupported value type ${n?.atom ?? '(list)'}`, n);
    return n.atom;
  };

  // Reads (param ...) (result ...) (local ...) prefixes of a func-like list.
  function signature(items, start, withLocals) {
    const params = [], results = [], locals = [], names = new Map();
    let i = start;
    for (; i < items.length; i++) {
      const h = head(items[i]);
      if (h !== 'param' && h !== 'result' && !(withLocals && h === 'local')) break;
      const rest = items[i].slice(1);
      if (h === 'result') { rest.forEach((n) => results.push(valtype(n))); continue; }
      if (h === 'param' && (results.length || locals.length)) throw new WatError('param after result/local', items[i]);
      const target = h === 'param' ? params : locals;
      if (isId(rest[0])) {
        if (rest.length !== 2) throw new WatError(`named ${h} takes exactly one type`, items[i]);
        if (names.has(rest[0].atom)) throw new WatError(`duplicate local ${rest[0].atom}`, rest[0]);
        // Params are fixed before any local appears, so this is the final index.
        names.set(rest[0].atom, params.length + (h === 'local' ? locals.length : 0));
        target.push(valtype(rest[1]));
      } else rest.forEach((n) => target.push(valtype(n)));
    }
    return { params, results, locals, names, next: i };
  }

  // Pass 1: collect index spaces (imports must precede definitions in the index space).
  for (const f of fields) {
    if (head(f) === 'import') {
      const [, mod, nm, desc] = f;
      if (head(desc) !== 'func') throw new WatError('only function imports are supported', f);
      let j = 1;
      if (isId(desc[1])) { funcNames.set(desc[1].atom, imports.length); j = 2; }
      const sig = signature(desc, j, false);
      imports.push([...name(mod.str), ...name(nm.str), 0x00, ...uleb(typeIndex(sig.params, sig.results))]);
    }
  }
  for (const f of fields) {
    if (head(f) === 'func') {
      const idx = imports.length + funcs.length;
      if (isId(f[1])) funcNames.set(f[1].atom, idx);
      funcs.push(f);
    } else if (head(f) === 'global') {
      if (isId(f[1])) globalNames.set(f[1].atom, globals.length);
      globals.push(f);
    }
  }

  const resolve = (node, map, what) => {
    if (isId(node)) {
      if (!map.has(node.atom)) throw new WatError(`unknown ${what} ${node.atom}`, node);
      return map.get(node.atom);
    }
    return u32(node);
  };

  const inlineExports = (items, start, kind, index) => {
    let j = start;
    while (head(items[j]) === 'export') { exports.push([...name(items[j][1].str), kind, ...uleb(index)]); j++; }
    return j;
  };

  const constExpr = (n) => {
    const h = head(n);
    if (h === 'i32.const') return [0x41, ...sleb(int(n[1], 32)), 0x0b];
    if (h === 'i64.const') return [0x42, ...sleb(int(n[1], 64)), 0x0b];
    if (h === 'global.get') return [0x23, ...uleb(resolve(n[1], globalNames, 'global')), 0x0b];
    throw new WatError('unsupported constant expression', n);
  };

  const globalEntries = globals.map((g, gi) => {
    let j = isId(g[1]) ? 2 : 1;
    j = inlineExports(g, j, 0x03, gi);
    const t = g[j];
    const [mut, vt] = head(t) === 'mut' ? [1, valtype(t[1])] : [0, valtype(t)];
    return [VALTYPE[vt], mut, ...constExpr(g[j + 1])];
  });

  for (const f of fields) {
    const h = head(f);
    if (h === 'memory') {
      if (memory) throw new WatError('only one memory is supported', f);
      let j = isId(f[1]) ? 2 : 1;
      j = inlineExports(f, j, 0x02, 0);
      const min = u32(f[j]);
      memory = f[j + 1] ? [0x01, ...uleb(min), ...uleb(u32(f[j + 1]))] : [0x00, ...uleb(min)];
    } else if (h === 'export') {
      const [, nm, desc] = f;
      const kinds = { func: [0x00, funcNames], memory: [0x02, new Map()], global: [0x03, globalNames] };
      const k = kinds[head(desc)];
      if (!k) throw new WatError(`unsupported export kind ${head(desc)}`, f);
      exports.push([...name(nm.str), k[0], ...uleb(resolve(desc[1], k[1], head(desc)))]);
    } else if (h === 'data') {
      let j = isId(f[1]) ? 2 : 1;
      const off = head(f[j]) === 'offset' ? f[j][1] : f[j];
      const bytes = f.slice(j + 1).flatMap((s) => {
        if (!s.str) throw new WatError('data segment expects strings', s);
        return [...s.str];
      });
      datas.push([0x00, ...constExpr(off), ...vec(bytes.map((b) => [b]))]);
    } else if (!['import', 'func', 'global'].includes(h)) {
      throw new WatError(`unsupported module field ${h}`, f);
    }
  }

  const funcTypes = [];
  const bodies = funcs.map((f, fi) => {
    let j = isId(f[1]) ? 2 : 1;
    j = inlineExports(f, j, 0x00, imports.length + fi);
    const sig = signature(f, j, true);
    funcTypes.push(uleb(typeIndex(sig.params, sig.results)));
    const code = compileBody(f.slice(sig.next), sig, { funcNames, globalNames, resolve });
    // Run-length encode local declarations.
    const groups = [];
    for (const t of sig.locals) {
      if (groups.length && groups.at(-1)[1] === t) groups.at(-1)[0]++;
      else groups.push([1, t]);
    }
    const body = [...vec(groups.map(([n, t]) => [...uleb(n), VALTYPE[t]])), ...code, 0x0b];
    return [...uleb(body.length), ...body];
  });

  const section = (id, items) => (items.length ? [id, ...uleb(vec(items).length), ...vec(items)] : []);
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types),
    ...section(2, imports),
    ...section(3, funcTypes),
    ...section(5, memory ? [memory] : []),
    ...section(6, globalEntries),
    ...section(7, exports),
    ...section(10, bodies),
    ...section(11, datas),
  ]);
}

// ── Function bodies ─────────────────────────────────────────────────────────

function compileBody(items, sig, mod) {
  const out = [];
  const labels = [];
  const localCount = sig.params.length + sig.locals.length;

  const local = (n) => {
    if (isId(n)) {
      if (!sig.names.has(n.atom)) throw new WatError(`unknown local ${n.atom}`, n);
      return sig.names.get(n.atom);
    }
    const i = u32(n);
    if (i >= localCount) throw new WatError(`local index ${i} out of range`, n);
    return i;
  };

  const label = (n) => {
    if (isId(n)) {
      const i = labels.lastIndexOf(n.atom);
      if (i < 0) throw new WatError(`unknown label ${n.atom}`, n);
      return labels.length - 1 - i;
    }
    return u32(n);
  };

  // Consumes an optional $label and (result t) after block/loop/if.
  function blockHeader(list, j) {
    let name = null;
    if (isId(list[j])) name = list[j++].atom;
    let bt = 0x40;
    if (head(list[j]) === 'param') throw new WatError('block params are not supported', list[j]);
    if (head(list[j]) === 'result') {
      const rs = list[j].slice(1);
      if (rs.length !== 1) throw new WatError('multi-value block results are not supported', list[j]);
      bt = VALTYPE[rs[0].atom];
      if (!bt) throw new WatError(`unsupported value type ${rs[0].atom}`, rs[0]);
      j++;
    }
    return { name, bt, next: j };
  }

  // Emits one non-structured instruction. `take()` returns the next immediate
  // atom or undefined; `peek()` looks at it without consuming.
  function simple(op, node, take, peek) {
    if (op in OPS) return out.push(...OPS[op]);
    if (op in MEM) {
      const [code, natural] = MEM[op];
      let offset = 0, align = natural;
      for (let a = peek(); isAtom(a) && /^(offset|align)=/.test(a.atom); a = peek()) {
        take();
        const [k, v] = a.atom.split('=');
        const val = u32({ atom: v, line: a.line });
        if (k === 'offset') offset = val;
        else {
          if (val & (val - 1) || val === 0) throw new WatError(`align must be a power of two`, a);
          align = Math.log2(val);
          if (align > natural) throw new WatError(`alignment larger than natural for ${op}`, a);
        }
      }
      return out.push(code, ...uleb(align), ...uleb(offset));
    }
    const need = () => {
      const a = take();
      if (!a) throw new WatError(`${op} needs an immediate`, node);
      return a;
    };
    switch (op) {
      case 'i32.const': return out.push(0x41, ...sleb(int(need(), 32)));
      case 'i64.const': return out.push(0x42, ...sleb(int(need(), 64)));
      case 'local.get': return out.push(0x20, ...uleb(local(need())));
      case 'local.set': return out.push(0x21, ...uleb(local(need())));
      case 'local.tee': return out.push(0x22, ...uleb(local(need())));
      case 'global.get': return out.push(0x23, ...uleb(mod.resolve(need(), mod.globalNames, 'global')));
      case 'global.set': return out.push(0x24, ...uleb(mod.resolve(need(), mod.globalNames, 'global')));
      case 'call': return out.push(0x10, ...uleb(mod.resolve(need(), mod.funcNames, 'function')));
      case 'br': return out.push(0x0c, ...uleb(label(need())));
      case 'br_if': return out.push(0x0d, ...uleb(label(need())));
      case 'br_table': {
        const targets = [];
        for (let a = peek(); isAtom(a) && (isId(a) || /^\d/.test(a.atom)); a = peek()) targets.push(label(take()));
        if (!targets.length) throw new WatError('br_table needs at least a default label', node);
        const dflt = targets.pop();
        return out.push(0x0e, ...vec(targets.map((t) => uleb(t))), ...uleb(dflt));
      }
    }
    throw new WatError(`unsupported instruction ${op}`, node);
  }

  // Plain (linear) instruction sequence.
  function seq(list, start = 0) {
    let i = start;
    const take = () => (isAtom(list[i]) ? list[i++] : undefined);
    const peek = () => list[i];
    while (i < list.length) {
      const n = list[i++];
      if (isList(n)) { folded(n); continue; }
      if (!isAtom(n)) throw new WatError('unexpected string in function body', n);
      const op = n.atom;
      if (op === 'block' || op === 'loop' || op === 'if') {
        const h = blockHeader(list, i);
        i = h.next;
        labels.push(h.name);
        out.push({ block: 0x02, loop: 0x03, if: 0x04 }[op], h.bt);
      } else if (op === 'else' || op === 'end') {
        if (!labels.length) throw new WatError(`${op} without matching block`, n);
        if (isId(list[i])) i++; // optional trailing label
        if (op === 'end') labels.pop();
        out.push(op === 'end' ? 0x0b : 0x05);
      } else simple(op, n, take, peek);
    }
  }

  // Folded S-expression instruction.
  function folded(list) {
    const op = head(list);
    if (!op) throw new WatError('expected instruction', list);
    if (op === 'block' || op === 'loop') {
      const h = blockHeader(list, 1);
      labels.push(h.name);
      out.push(op === 'block' ? 0x02 : 0x03, h.bt);
      seq(list, h.next);
      labels.pop();
      out.push(0x0b);
      return;
    }
    if (op === 'if') {
      const h = blockHeader(list, 1);
      let j = h.next;
      while (j < list.length && head(list[j]) !== 'then') folded(list[j++]);
      const thenL = list[j], elseL = list[j + 1];
      if (head(thenL) !== 'then') throw new WatError('folded if needs (then ...)', list);
      if (elseL && head(elseL) !== 'else') throw new WatError('expected (else ...)', elseL);
      labels.push(h.name);
      out.push(0x04, h.bt);
      seq(thenL, 1);
      if (elseL) { out.push(0x05); seq(elseL, 1); }
      labels.pop();
      out.push(0x0b);
      return;
    }
    // (op imm* operand*): operands are evaluated first, then the op.
    let j = 1;
    const imms = [];
    while (j < list.length && !isList(list[j])) imms.push(list[j++]);
    list.slice(j).forEach((operand) => {
      if (!isList(operand)) throw new WatError('immediates must precede operands', operand);
      folded(operand);
    });
    let k = 0;
    simple(op, list[0], () => imms[k++], () => imms[k]);
    if (k !== imms.length) throw new WatError(`unexpected immediate ${imms[k].atom} for ${op}`, imms[k]);
  }

  seq(items);
  if (labels.length) throw new WatError('unclosed block in function body', items[0]);
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const isMain = import.meta.main ?? (typeof process !== 'undefined' && process.argv[1] &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href);

if (isMain) {
  const fs = await import('node:fs');
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: node tools/wat.js in.wat out.wasm');
    process.exit(1);
  }
  const bytes = assemble(fs.readFileSync(input, 'utf8'));
  if (!WebAssembly.validate(bytes)) {
    console.error(`${input}: assembled module failed WebAssembly.validate`);
    process.exit(1);
  }
  fs.writeFileSync(output, bytes);
}
