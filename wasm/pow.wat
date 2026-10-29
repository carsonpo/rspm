;; SHA-256 (FIPS 180-4) and proof-of-work nonce search. Hand-written.
;;
;; Memory layout:
;;      0  K[64]       round constants (little-endian i32, so i32.load reads them directly)
;;    256  W[64]       message schedule
;;    512  H[8]        working hash state
;;    544  M[8]        saved midstate (state before the block holding the counter)
;;   1024  message     padded by the caller to a multiple of 64 bytes
;;
;; The caller (core/pow.js) pads the message. Digest words are left in H as
;; native i32s; the caller serializes them big-endian.

(module
  (memory (export "memory") 1)

  (data (i32.const 0)
    "\98\2f\8a\42\91\44\37\71\cf\fb\c0\b5\a5\db\b5\e9"
    "\5b\c2\56\39\f1\11\f1\59\a4\82\3f\92\d5\5e\1c\ab"
    "\98\aa\07\d8\01\5b\83\12\be\85\31\24\c3\7d\0c\55"
    "\74\5d\be\72\fe\b1\de\80\a7\06\dc\9b\74\f1\9b\c1"
    "\c1\69\9b\e4\86\47\be\ef\c6\9d\c1\0f\cc\a1\0c\24"
    "\6f\2c\e9\2d\aa\84\74\4a\dc\a9\b0\5c\da\88\f9\76"
    "\52\51\3e\98\6d\c6\31\a8\c8\27\03\b0\c7\7f\59\bf"
    "\f3\0b\e0\c6\47\91\a7\d5\51\63\ca\06\67\29\29\14"
    "\85\0a\b7\27\38\21\1b\2e\fc\6d\2c\4d\13\0d\38\53"
    "\54\73\0a\65\bb\0a\6a\76\2e\c9\c2\81\85\2c\72\92"
    "\a1\e8\bf\a2\4b\66\1a\a8\70\8b\4b\c2\a3\51\6c\c7"
    "\19\e8\92\d1\24\06\99\d6\85\35\0e\f4\70\a0\6a\10"
    "\16\c1\a4\19\08\6c\37\1e\4c\77\48\27\b5\bc\b0\34"
    "\b3\0c\1c\39\4a\aa\d8\4e\4f\ca\9c\5b\f3\6f\2e\68"
    "\ee\82\8f\74\6f\63\a5\78\14\78\c8\84\08\02\c7\8c"
    "\fa\ff\be\90\eb\6c\50\a4\f7\a3\f9\be\f2\78\71\c6")

  (func $bswap (param $x i32) (result i32)
    (i32.or
      (i32.or (i32.shl (local.get $x) (i32.const 24))
              (i32.shl (i32.and (local.get $x) (i32.const 0xff00)) (i32.const 8)))
      (i32.or (i32.and (i32.shr_u (local.get $x) (i32.const 8)) (i32.const 0xff00))
              (i32.shr_u (local.get $x) (i32.const 24)))))

  (func $init
    (i32.store offset=512 (i32.const 0) (i32.const 0x6a09e667))
    (i32.store offset=516 (i32.const 0) (i32.const 0xbb67ae85))
    (i32.store offset=520 (i32.const 0) (i32.const 0x3c6ef372))
    (i32.store offset=524 (i32.const 0) (i32.const 0xa54ff53a))
    (i32.store offset=528 (i32.const 0) (i32.const 0x510e527f))
    (i32.store offset=532 (i32.const 0) (i32.const 0x9b05688c))
    (i32.store offset=536 (i32.const 0) (i32.const 0x1f83d9ab))
    (i32.store offset=540 (i32.const 0) (i32.const 0x5be0cd19)))

  ;; Compress the 64-byte block at $p into H.
  (func $compress (param $p i32)
    (local $i i32) (local $x i32) (local $y i32) (local $t1 i32) (local $t2 i32)
    (local $a i32) (local $b i32) (local $c i32) (local $d i32)
    (local $e i32) (local $f i32) (local $g i32) (local $h i32)

    ;; W[0..15] = big-endian words of the block
    (loop $load
      (i32.store offset=256 (i32.shl (local.get $i) (i32.const 2))
        (call $bswap (i32.load align=1 (i32.add (local.get $p) (i32.shl (local.get $i) (i32.const 2))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $load (i32.lt_u (local.get $i) (i32.const 16))))

    ;; W[16..63] = σ1(W[i-2]) + W[i-7] + σ0(W[i-15]) + W[i-16]
    (loop $expand
      (local.set $x (i32.load offset=196 (i32.shl (local.get $i) (i32.const 2))))   ;; W[i-15]
      (local.set $y (i32.load offset=248 (i32.shl (local.get $i) (i32.const 2))))   ;; W[i-2]
      (i32.store offset=256 (i32.shl (local.get $i) (i32.const 2))
        (i32.add
          (i32.add (i32.load offset=192 (i32.shl (local.get $i) (i32.const 2)))     ;; W[i-16]
                   (i32.load offset=228 (i32.shl (local.get $i) (i32.const 2))))    ;; W[i-7]
          (i32.add
            (i32.xor (i32.xor (i32.rotr (local.get $x) (i32.const 7)) (i32.rotr (local.get $x) (i32.const 18)))
                     (i32.shr_u (local.get $x) (i32.const 3)))
            (i32.xor (i32.xor (i32.rotr (local.get $y) (i32.const 17)) (i32.rotr (local.get $y) (i32.const 19)))
                     (i32.shr_u (local.get $y) (i32.const 10))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $expand (i32.lt_u (local.get $i) (i32.const 64))))

    (local.set $a (i32.load offset=512 (i32.const 0)))
    (local.set $b (i32.load offset=516 (i32.const 0)))
    (local.set $c (i32.load offset=520 (i32.const 0)))
    (local.set $d (i32.load offset=524 (i32.const 0)))
    (local.set $e (i32.load offset=528 (i32.const 0)))
    (local.set $f (i32.load offset=532 (i32.const 0)))
    (local.set $g (i32.load offset=536 (i32.const 0)))
    (local.set $h (i32.load offset=540 (i32.const 0)))

    (local.set $i (i32.const 0))
    (loop $round
      ;; t1 = h + Σ1(e) + Ch(e,f,g) + K[i] + W[i]
      (local.set $t1
        (i32.add
          (i32.add (local.get $h)
            (i32.xor (i32.xor (i32.rotr (local.get $e) (i32.const 6)) (i32.rotr (local.get $e) (i32.const 11)))
                     (i32.rotr (local.get $e) (i32.const 25))))
          (i32.add
            (i32.xor (local.get $g) (i32.and (local.get $e) (i32.xor (local.get $f) (local.get $g))))
            (i32.add (i32.load (i32.shl (local.get $i) (i32.const 2)))
                     (i32.load offset=256 (i32.shl (local.get $i) (i32.const 2)))))))
      ;; t2 = Σ0(a) + Maj(a,b,c)
      (local.set $t2
        (i32.add
          (i32.xor (i32.xor (i32.rotr (local.get $a) (i32.const 2)) (i32.rotr (local.get $a) (i32.const 13)))
                   (i32.rotr (local.get $a) (i32.const 22)))
          (i32.or (i32.and (local.get $a) (local.get $b))
                  (i32.and (local.get $c) (i32.or (local.get $a) (local.get $b))))))
      (local.set $h (local.get $g))
      (local.set $g (local.get $f))
      (local.set $f (local.get $e))
      (local.set $e (i32.add (local.get $d) (local.get $t1)))
      (local.set $d (local.get $c))
      (local.set $c (local.get $b))
      (local.set $b (local.get $a))
      (local.set $a (i32.add (local.get $t1) (local.get $t2)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $round (i32.lt_u (local.get $i) (i32.const 64))))

    (i32.store offset=512 (i32.const 0) (i32.add (i32.load offset=512 (i32.const 0)) (local.get $a)))
    (i32.store offset=516 (i32.const 0) (i32.add (i32.load offset=516 (i32.const 0)) (local.get $b)))
    (i32.store offset=520 (i32.const 0) (i32.add (i32.load offset=520 (i32.const 0)) (local.get $c)))
    (i32.store offset=524 (i32.const 0) (i32.add (i32.load offset=524 (i32.const 0)) (local.get $d)))
    (i32.store offset=528 (i32.const 0) (i32.add (i32.load offset=528 (i32.const 0)) (local.get $e)))
    (i32.store offset=532 (i32.const 0) (i32.add (i32.load offset=532 (i32.const 0)) (local.get $f)))
    (i32.store offset=536 (i32.const 0) (i32.add (i32.load offset=536 (i32.const 0)) (local.get $g)))
    (i32.store offset=540 (i32.const 0) (i32.add (i32.load offset=540 (i32.const 0)) (local.get $h))))

  ;; Compress blocks [$from, $to) of the message.
  (func $blocks (param $from i32) (param $to i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $from) (local.get $to)))
        (call $compress (i32.add (i32.const 1024) (i32.shl (local.get $from) (i32.const 6))))
        (local.set $from (i32.add (local.get $from) (i32.const 1)))
        (br $next))))

  ;; SHA-256 of the padded message: $n blocks at 1024. Result in H.
  (func (export "digest") (param $n i32)
    (call $init)
    (call $blocks (i32.const 0) (local.get $n)))

  ;; Proof-of-work search. A 4-byte big-endian counter lives at message offset
  ;; $off. Tries counters [$start, $start + $count) and returns the first whose
  ;; digest has at least $bits leading zero bits, or -1. The digest of the
  ;; winner is left in H.
  (func (export "search") (param $n i32) (param $off i32) (param $bits i32)
                          (param $start i32) (param $count i32) (result i32)
    (local $first i32) (local $ctr i32) (local $end i32) (local $h0 i32) (local $lz i32)
    (local.set $first (i32.shr_u (local.get $off) (i32.const 6)))
    (call $init)
    (call $blocks (i32.const 0) (local.get $first))
    (memory.copy (i32.const 544) (i32.const 512) (i32.const 32))
    (local.set $ctr (local.get $start))
    (local.set $end (i32.add (local.get $start) (local.get $count)))
    (block $fail
      (loop $try
        (br_if $fail (i32.eq (local.get $ctr) (local.get $end)))
        (i32.store align=1 (i32.add (i32.const 1024) (local.get $off)) (call $bswap (local.get $ctr)))
        (memory.copy (i32.const 512) (i32.const 544) (i32.const 32))
        (call $blocks (local.get $first) (local.get $n))
        (local.set $h0 (i32.load offset=512 (i32.const 0)))
        (local.set $lz
          (if (result i32) (local.get $h0)
            (then (i32.clz (local.get $h0)))
            (else (i32.add (i32.const 32) (i32.clz (i32.load offset=516 (i32.const 0)))))))
        (if (i32.ge_u (local.get $lz) (local.get $bits))
          (then (return (local.get $ctr))))
        (local.set $ctr (i32.add (local.get $ctr) (i32.const 1)))
        (br $try)))
    (i32.const -1))
)
