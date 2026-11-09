# Apple Lossless (ALAC) decoder

The decoder half of Apple's open-source ALAC codec:
https://github.com/macosforge/alac (`codec/`), commit `c38887c5c5e64a4b31108733bd79ca9b2496d987`. Apache License 2.0 — see `LICENSE`.

Only the decoding files are here (no encoder, no `convert-utility`). The engine reads the MP4 /
M4A container itself (`src/AlacSource.cpp`) and hands each packet to `ALACDecoder`; the cookie
and packets go in zero-padded, since the decoder trusts their lengths.

## Changes for Audio Harbor

Two guards against damaged packets, found by fuzzing under UndefinedBehaviorSanitizer; valid
streams decode exactly as before (bit-exact against ffmpeg, `engine/test/AlacTest.cpp`). Each is
marked `Audio Harbor` in the source.

- `dp_dec.c` `unpc_block`: `denhalf` is 0 for a `denshift` of 0 instead of shifting by -1.
- `ALACDecoder.cpp` `Decode`: a `mixBits` of 32 or more is refused (`kALAC_ParamError`) — shifting by
  it is undefined. Encoders write 2.

The files are compiled with `-fwrapv` (`engine/CMakeLists.txt`): the predictor can overflow on a
damaged packet, which then wraps (noise) instead of being undefined behaviour.

