import { assemble } from '../tools/wat.js';
import { eq, ok, throws, hex } from '../tools/check.js';

const run = async (src, imports = {}) => {
  const bytes = assemble(src);
  ok(WebAssembly.validate(bytes), 'module must validate');
  return (await WebAssembly.instantiate(bytes, imports)).instance.exports;
};

export function emptyModule() {
  eq(hex(assemble('(module)')), '0061736d01000000');
}

// Byte-for-byte what wat2wasm emits for the canonical add example.
export function addMatchesWat2wasm() {
  const bytes = assemble(`(module
    (func (export "add") (param i32 i32) (result i32)
      local.get 0 local.get 1 i32.add))`);
  eq(hex(bytes), '0061736d0100000001070160027f7f017f03020100070701036164640000' + '0a09010700200020016a0b');
}

export async function foldedAndNamed() {
  const { add } = await run(`(module
    (func $add (export "add") (param $a i32) (param $b i32) (result i32)
      (i32.add (local.get $a) (local.get $b))))`);
  eq(add(2, 3), 5);
  eq(add(-1, 1), 0);
}

export async function constantsWrap() {
  const { a, b, c } = await run(`(module
    (func (export "a") (result i32) (i32.const 0xffff_ffff))
    (func (export "b") (result i64) (i64.const -0x8000_0000_0000_0000))
    (func (export "c") (result i64) (i64.const 0xffffffffffffffff)))`);
  eq(a(), -1);
  eq(b(), -(2n ** 63n));
  eq(c(), -1n);
  throws(() => assemble('(module (func (result i32) (i32.const 0x1_0000_0000)))'), /out of range/);
}

export async function i64RotateAndShifts() {
  const { rotr, shr } = await run(`(module
    (func (export "rotr") (param i64 i64) (result i64) (i64.rotr (local.get 0) (local.get 1)))
    (func (export "shr") (param i64) (result i64) (i64.shr_u (local.get 0) (i64.const 60))))`);
  eq(rotr(1n, 1n), -(2n ** 63n));
  eq(shr(-1n), 15n);
}

export async function loopsAndLocals() {
  // sum 1..n with a plain-form labeled loop
  const { sum } = await run(`(module
    (func (export "sum") (param $n i32) (result i32) (local $acc i32) (local $i i32)
      block $done
        loop $next
          local.get $i local.get $n i32.ge_u br_if $done
          local.get $i i32.const 1 i32.add local.tee $i
          local.get $acc i32.add local.set $acc
          br $next
        end $next
      end
      local.get $acc))`);
  eq(sum(0), 0);
  eq(sum(100), 5050);
}

export async function ifElseWithResult() {
  const { max } = await run(`(module
    (func (export "max") (param i32 i32) (result i32)
      (if (result i32) (i32.gt_s (local.get 0) (local.get 1))
        (then (local.get 0))
        (else (local.get 1)))))`);
  eq(max(3, 7), 7);
  eq(max(-2, -9), -2);
}

export async function brTable() {
  const { pick } = await run(`(module
    (func (export "pick") (param i32) (result i32)
      (block $c (block $b (block $a
        (br_table $a $b $c (local.get 0)))
        (return (i32.const 10)))
        (return (i32.const 20)))
      (i32.const 30)))`);
  eq([pick(0), pick(1), pick(2), pick(99)], [10, 20, 30, 30]);
}

export async function memoryDataAndBulk() {
  const { memory, load, copy } = await run(`(module
    (memory (export "memory") 1)
    (data (i32.const 16) "\\01\\02\\03\\04" "hi")
    (func (export "load") (param i32) (result i32) (i32.load offset=16 (local.get 0)))
    (func (export "copy")
      (memory.copy (i32.const 100) (i32.const 16) (i32.const 6))
      (memory.fill (i32.const 200) (i32.const 0xab) (i32.const 3))))`);
  eq(load(0), 0x04030201);
  copy();
  const m = new Uint8Array(memory.buffer);
  eq(hex(m.slice(100, 106)), '010203046869');
  eq(hex(m.slice(200, 204)), 'ababab00');
}

export async function globalsAndImports() {
  const seen = [];
  const { bump } = await run(`(module
    (import "env" "log" (func $log (param i64)))
    (global $count (mut i64) (i64.const 41))
    (func (export "bump") (result i64)
      (global.set $count (i64.add (global.get $count) (i64.const 1)))
      (call $log (global.get $count))
      (global.get $count)))`, { env: { log: (v) => seen.push(v) } });
  eq(bump(), 42n);
  eq(seen, [42n]);
}

export async function narrowLoadsAndStores() {
  const { rt } = await run(`(module (memory 1)
    (func (export "rt") (param i32) (result i32)
      (i32.store8 (i32.const 0) (local.get 0))
      (i32.load8_s (i32.const 0))))`);
  eq(rt(0xff), -1);
  eq(rt(0x7f), 127);
}

export function errorsAreLoud() {
  throws(() => assemble('(module (func (f32.const 1)))'), /unsupported instruction f32.const/);
  throws(() => assemble('(module (func (local.get $nope)))'), /unknown local \$nope/);
  throws(() => assemble('(module (func br $x))'), /unknown label/);
  throws(() => assemble('(module (func block))'), /unclosed block/);
  throws(() => assemble('(module (table 1 funcref))'), /unsupported module field table/);
  throws(() => assemble('(module (func (i32.load align=8 (i32.const 0))))'), /alignment larger/);
  throws(() => assemble('(module\n\n (func (i32.bogus)))'), /line 3/);
}
