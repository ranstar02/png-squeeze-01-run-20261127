# PNG Squeezer — palette, grey and adaptive-filter lossless re-encoder

One `main.ts` (Node 22, built-ins only) that reads `/input/<id>/image.png`
(1280×720 RGBA stored PNGs) and writes a lossless re-encoding to
`/output/<id>/image.png`, as small as it can.

## How it works

1. **Own PNG decoder** — parses IHDR/PLTE/tRNS/IDAT/IEND, inflates, unfilters
   (filters 0–4), supports colour types 0, 2, 3, 4, 6 at bit depth 8.
2. **Colour-type reduction** — one analysis pass counts unique colours and
   checks opaque/grey, then tries every applicable form: palette (by
   frequency and by luminance, transparent entries first), grey, grey+alpha,
   RGB, RGBA.
3. **Filter search** — candidates are ranked by a fast (level 1) deflate of
   their fixed-None, fixed-Up and per-row minsum streams. The winner also
   gets fixed-Sub, fixed-Paeth, fewest-distinct-pairs and brute-force
   (per-row deflate trials with a 32 KiB dictionary) streams.
4. **Final encode** — every winner stream is deflated at zlib level 9; the
   best stream is also tried with `Z_FILTERED` and at level 6 (level 6
   occasionally beats level 9). Smallest file wins. One IDAT, no extra
   chunks. Deterministic: fixed work, no clock, no randomness.

## How to run locally

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice score

**703,457 / 1,000,000** on the kit practice set (house baseline fixed-paeth:
420,399). Per instance (bytes / points): i001 12,496 / 718.37, i002 52,273 /
700.44, i003 107,626 / 668.31, i004 106,248 / 692.44, i005 16,552 / 742.25,
i006 178,840 / 689.89, i007 60,890 / 701.87, i008 24,900 / 714.08. All 8
outputs decode pixel-exact. Full-set runtime ≈ 21 s locally.

## License

MIT — see `LICENSE`.
