;; RSPM client tag — PROTOCOL §9.3.
;;
;; THIS IS NOT A SECURITY MECHANISM. It is a deliberately obscure, public
;; function that a client and the worker both compute over the current 30-second
;; window. It exists only to turn away scripts written by people who didn't
;; bother to read this file. Anyone who did read it can compute the tag.
;; Proof-of-work and rate limits are the actual abuse controls.
;;
;; Interface (stable): tag(window: u32) -> u32. The body may change any release.

(module
  (func (export "tag") (param $w i32) (result i32)
    (local $x i32) (local $y i32) (local $r i32)
    ;; golden-ratio spread, then fold the window's own popcount into a rotation
    (local.set $x (i32.mul (i32.xor (local.get $w) (i32.const 0x5253504d)) (i32.const 0x9e3779b1)))
    (local.set $r (i32.and (i32.add (i32.popcnt (local.get $w)) (i32.const 7)) (i32.const 31)))
    (local.set $x (i32.xor (local.get $x) (i32.rotl (local.get $x) (local.get $r))))
    ;; three rounds of an xorshift-multiply, each keyed by the previous round's top nibble
    (local.set $y (i32.const 3))
    (loop $round
      (local.set $x (i32.xor (local.get $x) (i32.shr_u (local.get $x) (i32.const 15))))
      (local.set $x (i32.mul (local.get $x)
        (i32.or (i32.const 0x2c1b3c6d) (i32.shl (i32.shr_u (local.get $x) (i32.const 28)) (i32.const 1)))))
      (local.set $x (i32.xor (local.get $x) (i32.rotr (local.get $x) (i32.add (local.get $y) (i32.const 9)))))
      (local.set $y (i32.sub (local.get $y) (i32.const 1)))
      (br_if $round (local.get $y)))
    ;; never zero, so a missing header can't collide with a valid tag
    (i32.or (local.get $x) (i32.const 1)))
)
