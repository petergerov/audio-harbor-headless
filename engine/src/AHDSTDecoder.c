/*
 * Audio Harbor MPEG-4 DST decoder.
 * Implements ISO/IEC 14496-3 Subpart 10 (lossless coding of oversampled audio).
 * Original Harbor code — not derived from FFmpeg, sacd-ripper, or other extractors.
 */

#include "AHDSTDecoder.h"

#include <stdlib.h>
#include <string.h>

#define AHDST_MAX_CHANNELS 6
#define AHDST_MAX_ELEMENTS 12

typedef struct {
    const uint8_t *data;
    size_t size;
    size_t byte_index;
    uint32_t cache;
    int cache_bits;
} BitReader;

typedef struct {
    unsigned a;
    unsigned c;
    BitReader *bits;
} ArithCoder;

typedef struct {
    unsigned elements;
    unsigned length[AHDST_MAX_ELEMENTS];
    int coeff[AHDST_MAX_ELEMENTS][128];
} CoeffTable;

struct AHDSTDecoder {
    int sample_rate_hz;
    int channels;
    unsigned bits_per_channel;
    size_t bytes_per_channel;
    CoeffTable filters;
    CoeffTable probs;
    uint8_t status[AHDST_MAX_CHANNELS][16];
    int16_t filter[AHDST_MAX_ELEMENTS][16][256];
};

static const int8_t kFilterPred[3][3] = {
    { -8 },
    { -16, 8 },
    { -9, -5, 6 },
};

static const int8_t kProbPred[3][3] = {
    { -8 },
    { -16, 8 },
    { -24, 24, -8 },
};

static int floor_log2(unsigned value) {
    return value ? 31 - __builtin_clz(value) : -1;
}

static void bits_init(BitReader *bits, const uint8_t *data, size_t size) {
    bits->data = data;
    bits->size = size;
    bits->byte_index = 0;
    bits->cache = 0;
    bits->cache_bits = 0;
}

static void bits_refill(BitReader *bits, int need) {
    while (bits->cache_bits < need) {
        unsigned next = 0;
        if (bits->byte_index < bits->size) {
            next = bits->data[bits->byte_index++];
        }
        bits->cache = (bits->cache << 8) | next;
        bits->cache_bits += 8;
    }
}

static unsigned bits_get(BitReader *bits, int count) {
    if (count <= 0) {
        return 0;
    }
    if (count > 24) {
        unsigned high = bits_get(bits, count - 16);
        unsigned low = bits_get(bits, 16);
        return (high << 16) | low;
    }
    bits_refill(bits, count);
    bits->cache_bits -= count;
    return (bits->cache >> bits->cache_bits) & ((1u << count) - 1u);
}

static int bits_get1(BitReader *bits) {
    return (int)bits_get(bits, 1);
}

static int bits_sget(BitReader *bits, int count) {
    unsigned value = bits_get(bits, count);
    unsigned sign = 1u << (count - 1);
    if (value & sign) {
        return (int)value - (int)(1u << count);
    }
    return (int)value;
}

static int rice_unsigned(BitReader *bits, unsigned k) {
    int quotient = 0;
    while (bits_get1(bits) == 0) {
        quotient++;
        if (quotient > 2048) {
            return -1;
        }
    }
    unsigned remainder = bits_get(bits, (int)k);
    return (quotient << k) | (int)remainder;
}

static int rice_signed(BitReader *bits, unsigned k) {
    int value = rice_unsigned(bits, k);
    if (value < 0) {
        return value;
    }
    if (value != 0 && bits_get1(bits)) {
        value = -value;
    }
    return value;
}

static void read_raw_coeffs(BitReader *bits, int *dest, unsigned count, int width, int is_signed, int offset) {
    for (unsigned i = 0; i < count; i++) {
        dest[i] = (is_signed ? bits_sget(bits, width) : (int)bits_get(bits, width)) + offset;
    }
}

static int read_coeff_table(
    BitReader *bits,
    CoeffTable *table,
    const int8_t pred[3][3],
    int length_bits,
    int coeff_bits,
    int is_signed,
    int offset
) {
    for (unsigned i = 0; i < table->elements; i++) {
        table->length[i] = bits_get(bits, length_bits) + 1;
        if (table->length[i] == 0 || table->length[i] > 128) {
            return AHDST_ERR_DATA;
        }
        if (!bits_get1(bits)) {
            read_raw_coeffs(bits, table->coeff[i], table->length[i], coeff_bits, is_signed, offset);
            continue;
        }

        int method = (int)bits_get(bits, 2);
        if (method == 3) {
            return AHDST_ERR_DATA;
        }
        read_raw_coeffs(bits, table->coeff[i], (unsigned)method + 1, coeff_bits, is_signed, offset);
        unsigned lsb = bits_get(bits, 3);
        for (unsigned j = (unsigned)method + 1; j < table->length[i]; j++) {
            int predicted = 0;
            for (int k = 0; k < method + 1; k++) {
                predicted += pred[method][k] * table->coeff[i][j - (unsigned)k - 1];
            }
            int residual = rice_signed(bits, lsb);
            if (residual < -1024 || residual > 1024) {
                return AHDST_ERR_DATA;
            }
            if (predicted >= 0) {
                residual -= (predicted + 4) / 8;
            } else {
                residual += (-predicted + 3) / 8;
            }
            if (!is_signed) {
                int max = offset + (1 << coeff_bits);
                if (residual < offset || residual >= max) {
                    return AHDST_ERR_DATA;
                }
            }
            table->coeff[i][j] = residual;
        }
    }
    return AHDST_OK;
}

static int read_channel_map(BitReader *bits, CoeffTable *table, unsigned *map, int channels) {
    table->elements = 1;
    map[0] = 0;
    if (bits_get1(bits)) {
        for (int ch = 1; ch < channels; ch++) {
            map[ch] = 0;
        }
        return AHDST_OK;
    }

    for (int ch = 1; ch < channels; ch++) {
        int width = floor_log2(table->elements) + 1;
        unsigned mapped = bits_get(bits, width);
        if (mapped == table->elements) {
            table->elements++;
            if (table->elements >= AHDST_MAX_ELEMENTS) {
                return AHDST_ERR_DATA;
            }
        } else if (mapped > table->elements) {
            return AHDST_ERR_DATA;
        }
        map[ch] = mapped;
    }
    return AHDST_OK;
}

static void arith_init(ArithCoder *ac, BitReader *bits) {
    ac->a = 4095;
    ac->bits = bits;
    ac->c = bits_get(bits, 12);
}

static int arith_get(ArithCoder *ac, int probability) {
    unsigned k = (ac->a >> 8) | ((ac->a >> 7) & 1u);
    unsigned q = k * (unsigned)probability;
    unsigned a_q = ac->a - q;
    int bit = ac->c < a_q;
    if (bit) {
        ac->a = a_q;
    } else {
        ac->a = q;
        ac->c -= a_q;
    }
    if (ac->a < 2048) {
        int shift = 11 - floor_log2(ac->a);
        ac->a <<= shift;
        ac->c = (ac->c << shift) | bits_get(ac->bits, shift);
    }
    return bit;
}

static uint8_t dst_x_probability(int coeff) {
    unsigned bits = (unsigned)(coeff & 127);
    unsigned reversed = 0;
    for (int i = 0; i < 7; i++) {
        reversed = (reversed << 1) | (bits & 1u);
        bits >>= 1;
    }
    return (uint8_t)(reversed + 1);
}

static int build_filter_lookup(struct AHDSTDecoder *decoder) {
    for (unsigned set = 0; set < decoder->filters.elements; set++) {
        int length = (int)decoder->filters.length[set];
        for (int group = 0; group < 16; group++) {
            int take = length - group * 8;
            if (take < 0) {
                take = 0;
            }
            if (take > 8) {
                take = 8;
            }
            for (int pattern = 0; pattern < 256; pattern++) {
                int sum = 0;
                for (int bit = 0; bit < take; bit++) {
                    int sign = ((pattern >> bit) & 1) ? 1 : -1;
                    sum += sign * decoder->filters.coeff[set][group * 8 + bit];
                }
                if ((int16_t)sum != sum) {
                    return AHDST_ERR_DATA;
                }
                decoder->filter[set][group][pattern] = (int16_t)sum;
            }
        }
    }
    return AHDST_OK;
}

static void shift_status(uint8_t status[16], int bit) {
    unsigned carry = (unsigned)(bit & 1);
    for (int i = 0; i < 16; i++) {
        unsigned next = status[i] >> 7;
        status[i] = (uint8_t)((status[i] << 1) | carry);
        carry = next;
    }
}

static int copy_raw_dsd(
    const uint8_t *src,
    size_t src_size,
    uint8_t *out,
    size_t out_size,
    int channels,
    size_t bytes_per_channel
) {
    size_t needed = bytes_per_channel * (size_t)channels;
    if (src_size < needed || out_size < needed) {
        return AHDST_ERR_DATA;
    }
    memcpy(out, src, needed);
    return AHDST_OK;
}

AHDSTDecoder *AHDSTDecoderCreate(int sample_rate_hz, int channel_count) {
    if (channel_count < 1 || channel_count > AHDST_MAX_CHANNELS) {
        return NULL;
    }
    if (sample_rate_hz < 44100 || (sample_rate_hz % 44100) != 0) {
        return NULL;
    }
    int oversample = sample_rate_hz / 44100;
    if (oversample > 256) {
        return NULL;
    }

    AHDSTDecoder *decoder = calloc(1, sizeof(*decoder));
    if (!decoder) {
        return NULL;
    }
    decoder->sample_rate_hz = sample_rate_hz;
    decoder->channels = channel_count;
    decoder->bits_per_channel = (unsigned)(588 * oversample);
    decoder->bytes_per_channel = decoder->bits_per_channel / 8;
    return decoder;
}

void AHDSTDecoderDestroy(AHDSTDecoder *decoder) {
    free(decoder);
}

size_t AHDSTDecoderBytesPerChannel(const AHDSTDecoder *decoder) {
    return decoder ? decoder->bytes_per_channel : 0;
}

size_t AHDSTDecoderFrameByteCount(const AHDSTDecoder *decoder) {
    if (!decoder) {
        return 0;
    }
    return decoder->bytes_per_channel * (size_t)decoder->channels;
}

int AHDSTDecoderDecode(
    AHDSTDecoder *decoder,
    const uint8_t *dst_frame,
    size_t dst_size,
    uint8_t *out_dsd,
    size_t out_size
) {
    if (!decoder || !dst_frame || !out_dsd || dst_size == 0) {
        return AHDST_ERR_ARGUMENT;
    }

    size_t frame_bytes = AHDSTDecoderFrameByteCount(decoder);
    if (out_size < frame_bytes) {
        return AHDST_ERR_ARGUMENT;
    }
    memset(out_dsd, 0, frame_bytes);

    BitReader bits;
    bits_init(&bits, dst_frame, dst_size);

    if (!bits_get1(&bits)) {
        bits_get1(&bits);
        if (bits_get(&bits, 6) != 0) {
            return AHDST_ERR_DATA;
        }
        return copy_raw_dsd(dst_frame + 1, dst_size > 0 ? dst_size - 1 : 0, out_dsd, out_size, decoder->channels, decoder->bytes_per_channel);
    }

    // Segmentation — common Scarlet Book layout: one segment, all channels.
    if (!bits_get1(&bits) || !bits_get1(&bits) || !bits_get1(&bits)) {
        return AHDST_ERR_UNSUPPORTED;
    }

    unsigned filter_map[AHDST_MAX_CHANNELS] = {0};
    unsigned prob_map[AHDST_MAX_CHANNELS] = {0};
    int same_map = bits_get1(&bits);
    int rc = read_channel_map(&bits, &decoder->filters, filter_map, decoder->channels);
    if (rc != AHDST_OK) {
        return rc;
    }
    if (same_map) {
        decoder->probs.elements = decoder->filters.elements;
        memcpy(prob_map, filter_map, sizeof(filter_map));
    } else {
        rc = read_channel_map(&bits, &decoder->probs, prob_map, decoder->channels);
        if (rc != AHDST_OK) {
            return rc;
        }
    }

    unsigned half_prob[AHDST_MAX_CHANNELS];
    for (int ch = 0; ch < decoder->channels; ch++) {
        half_prob[ch] = (unsigned)bits_get1(&bits);
    }

    rc = read_coeff_table(&bits, &decoder->filters, kFilterPred, 7, 9, 1, 0);
    if (rc != AHDST_OK) {
        return rc;
    }
    rc = read_coeff_table(&bits, &decoder->probs, kProbPred, 6, 7, 0, 1);
    if (rc != AHDST_OK) {
        return rc;
    }

    if (bits_get1(&bits)) {
        return AHDST_ERR_DATA;
    }

    ArithCoder ac;
    arith_init(&ac, &bits);
    rc = build_filter_lookup(decoder);
    if (rc != AHDST_OK) {
        return rc;
    }

    memset(decoder->status, 0xAA, sizeof(decoder->status));
    (void)arith_get(&ac, dst_x_probability(decoder->filters.coeff[0][0]));

    for (unsigned sample = 0; sample < decoder->bits_per_channel; sample++) {
        for (int ch = 0; ch < decoder->channels; ch++) {
            unsigned filter_id = filter_map[ch];
            int16_t (*lookup)[256] = decoder->filter[filter_id];
            uint8_t *history = decoder->status[ch];
            int predict = 0;
            for (int group = 0; group < 16; group++) {
                predict += lookup[group][history[group]];
            }

            int probability;
            if (!half_prob[ch] || sample >= decoder->filters.length[filter_id]) {
                unsigned prob_id = prob_map[ch];
                unsigned index = (unsigned)(predict < 0 ? -predict : predict) >> 3;
                unsigned last = decoder->probs.length[prob_id];
                if (last == 0) {
                    return AHDST_ERR_DATA;
                }
                if (index >= last) {
                    index = last - 1;
                }
                probability = decoder->probs.coeff[prob_id][index];
            } else {
                probability = 128;
            }

            int residual = arith_get(&ac, probability);
            int bit = residual ^ (predict < 0 ? 1 : 0);
            size_t byte_index = ((size_t)(sample >> 3) * (size_t)decoder->channels) + (size_t)ch;
            out_dsd[byte_index] |= (uint8_t)(bit << (7 - (int)(sample & 7u)));
            shift_status(history, bit);
        }
    }

    return AHDST_OK;
}

int AHDSTDecoderSelfTest(void) {
    AHDSTDecoder *decoder = AHDSTDecoderCreate(2822400, 2);
    if (!decoder) {
        return 0;
    }

    size_t frame = AHDSTDecoderFrameByteCount(decoder);
    uint8_t *raw = calloc(1, 1 + frame);
    uint8_t *out = calloc(1, frame);
    if (!raw || !out) {
        free(raw);
        free(out);
        AHDSTDecoderDestroy(decoder);
        return 0;
    }

    // Uncompressed DST frame: first bit 0, reserved + stuffing 0, then interleaved DSD.
    raw[0] = 0x00;
    for (size_t i = 0; i < frame; i++) {
        raw[1 + i] = (uint8_t)(0x5A ^ (uint8_t)i);
    }

    int ok = AHDSTDecoderDecode(decoder, raw, 1 + frame, out, frame) == AHDST_OK
        && memcmp(out, raw + 1, frame) == 0;

    free(raw);
    free(out);
    AHDSTDecoderDestroy(decoder);
    return ok;
}
