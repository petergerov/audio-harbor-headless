#ifndef AHDSTDecoder_h
#define AHDSTDecoder_h

#include <stddef.h>
#include <stdint.h>

#ifndef _Nullable
#define _Nullable
#endif
#ifndef _Nonnull
#define _Nonnull
#endif

#ifdef __cplusplus
extern "C" {
#endif

enum {
    AHDST_OK = 0,
    AHDST_ERR_ARGUMENT = -1,
    AHDST_ERR_DATA = -2,
    AHDST_ERR_UNSUPPORTED = -3
};

typedef struct AHDSTDecoder AHDSTDecoder;

/// MPEG-4 DST (ISO/IEC 14496-3 Subpart 10). `sample_rate_hz` is the DSD rate (e.g. 2822400).
AHDSTDecoder *_Nullable AHDSTDecoderCreate(int sample_rate_hz, int channel_count);
void AHDSTDecoderDestroy(AHDSTDecoder *_Nullable decoder);

size_t AHDSTDecoderBytesPerChannel(const AHDSTDecoder *_Nullable decoder);
size_t AHDSTDecoderFrameByteCount(const AHDSTDecoder *_Nullable decoder);

/// Decode one DST frame to packed interleaved DSD, MSB first, one byte per channel then next sample-byte.
int AHDSTDecoderDecode(
    AHDSTDecoder *_Nonnull decoder,
    const uint8_t *_Nonnull dst_frame,
    size_t dst_size,
    uint8_t *_Nonnull out_dsd,
    size_t out_size
);

int AHDSTDecoderSelfTest(void);

#ifdef __cplusplus
}
#endif

#endif
