#include "FrameSource.h"

#include "DsdPipeline.h"
#include "PcmDecoder.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

#include "../third_party/dr_flac.h"
#include "../third_party/dr_mp3.h"
#include "../third_party/dr_wav.h"

#if defined(__APPLE__)
#include <AudioToolbox/AudioToolbox.h>
#endif
#if !defined(_WIN32)
#include <sys/types.h>
#endif

namespace {

bool endsWithCi(const std::string& s, const char* ext) {
  const size_t n = std::strlen(ext);
  if (s.size() < n) return false;
  for (size_t i = 0; i < n; ++i) {
    if ((s[s.size() - n + i] | 32) != (ext[i] | 32)) return false;
  }
  return true;
}

void put16(uint8_t* o, int32_t v) {
  o[0] = uint8_t(v);
  o[1] = uint8_t(v >> 8);
}

void put24(uint8_t* o, int32_t v) {
  o[0] = uint8_t(v);
  o[1] = uint8_t(v >> 8);
  o[2] = uint8_t(v >> 16);
}

/** TPDF dither in (-1, 1) LSB, fixed per sample position so a re-read sends the same bytes. */
double tpdf(uint64_t frame, unsigned channel) {
  uint64_t x = frame * 0x9E3779B97F4A7C15ull + (uint64_t(channel) + 1) * 0xD1B54A32D192ED03ull;
  x ^= x >> 30;
  x *= 0xBF58476D1CE4E5B9ull;
  x ^= x >> 27;
  x *= 0x94D049BB133111EBull;
  x ^= x >> 31;
  const double a = double(x & 0xFFFFFF) / 16777216.0;
  const double b = double((x >> 24) & 0xFFFFFF) / 16777216.0;
  return a - b;
}

/**
 * Float (full scale ±1) to packed 16 / 24-bit. Scaled by 2^(bits-1) so samples that came
 * from integers of that depth or less go back unchanged. `dither` only matters for 16-bit.
 */
void packFloat(const float* in, size_t frames, unsigned channels, uint16_t bits, bool dither,
               uint64_t firstFrame, uint8_t* out) {
  if (bits == 16) {
    for (size_t f = 0; f < frames; ++f) {
      for (unsigned c = 0; c < channels; ++c) {
        double v = double(in[f * channels + c]) * 32768.0;
        if (dither) v += tpdf(firstFrame + f, c);
        put16(out, int32_t(std::clamp(std::nearbyint(v), -32768.0, 32767.0)));
        out += 2;
      }
    }
    return;
  }
  for (size_t i = 0; i < frames * channels; ++i) {
    const double v = std::nearbyint(double(in[i]) * 8388608.0);
    put24(out, int32_t(std::clamp(v, -8388608.0, 8388607.0)));
    out += 3;
  }
}

/** Left-justified 32-bit samples to their top 16 / 24 bits. */
void packS32(const int32_t* in, size_t samples, uint16_t bits, uint8_t* out) {
  if (bits == 16) {
    for (size_t i = 0; i < samples; ++i) put16(out + i * 2, in[i] >> 16);
  } else {
    for (size_t i = 0; i < samples; ++i) put24(out + i * 3, in[i] >> 8);
  }
}


void s32ToFloat(const int32_t* in, size_t samples, float* out) {
  for (size_t i = 0; i < samples; ++i) out[i] = float(in[i]) * (1.0f / 2147483648.0f);
}

class DsdSource final : public FrameSource {
public:
  bool open(const std::string& path, const FrameSourceOptions& options, std::string& error) {
    wifi_ = options.wifi;
    return reader_.open(path, float(options.dsdLevelDb), options.wifi, error);
  }
  uint32_t sampleRate() const override { return reader_.sampleRate(); }
  uint16_t channels() const override { return reader_.channels(); }
  uint64_t frameCount() const override { return reader_.frameCount(); }
  uint16_t bitsPerSample() const override { return wifi_ ? 16 : 24; }

  size_t readFloat(uint64_t startFrame, size_t count, float* out) override {
    return reader_.read(startFrame, count, out);
  }

  size_t readPacked(uint64_t startFrame, size_t count, uint8_t* out) override {
    floats_.resize(count * channels());
    const size_t n = reader_.read(startFrame, count, floats_.data());
    packFloat(floats_.data(), n, channels(), bitsPerSample(), true, startFrame, out);
    return n;
  }

private:
  DsdPcmReader reader_;
  bool wifi_ = false;
  std::vector<float> floats_;
};

/**
 * DSD as DoP: per channel and frame, two DSD bytes under a marker that alternates 0x05 / 0xFA
 * frame by frame. The marker follows the absolute frame, so a seek continues the sequence.
 */
class DopSource final : public FrameSource {
public:
  bool open(const std::string& path, std::string& error) {
    if (!bytes_.open(path, error)) return false;
    frames_ = bytes_.layout().bytesPerChannel / 2;
    if (frames_ == 0 || bytes_.layout().sampleRate < 16) {
      error = "DSD file has no audio";
      return false;
    }
    return true;
  }
  uint32_t sampleRate() const override { return bytes_.layout().sampleRate / 16; }
  uint16_t channels() const override { return bytes_.layout().channels; }
  uint64_t frameCount() const override { return frames_; }
  uint16_t bitsPerSample() const override { return 24; }

  bool isDop() const override { return true; }
  size_t readFloat(uint64_t, size_t, float*) override { return 0; }
  size_t readDop(uint64_t startFrame, size_t count, int32_t* out) override {
    if (startFrame >= frames_) return 0;
    count = size_t(std::min<uint64_t>(count, frames_ - startFrame));
    const uint16_t channels = this->channels();
    size_t written = 0;
    while (written < count) {
      const uint64_t frame = startFrame + written;
      const size_t readable = bytes_.ensure(frame * 2, 2);
      if (readable < 2) break;
      const size_t run = std::min(count - written, readable / 2);
      for (size_t f = 0; f < run; ++f) {
        const uint8_t marker = ((frame + f) & 1) ? 0xFA : 0x05;
        for (uint16_t c = 0; c < channels; ++c) {
          const uint8_t* dsd = bytes_.at(c, (frame + f) * 2);
          // marker in 31–24, older DSD byte in 23–16, newer in 15–8.
          out[(written + f) * channels + c] =
            (int32_t(marker) << 24) | (int32_t(dsd[0]) << 16) | (int32_t(dsd[1]) << 8);
        }
      }
      written += run;
    }
    return written;
  }

  size_t readPacked(uint64_t startFrame, size_t count, uint8_t* out) override {
    if (startFrame >= frames_) return 0;
    count = size_t(std::min<uint64_t>(count, frames_ - startFrame));
    const uint16_t channels = this->channels();
    size_t written = 0;
    while (written < count) {
      const uint64_t frame = startFrame + written;
      // The byte reader holds one chunk at a time: pack what it has, then load the next.
      const size_t readable = bytes_.ensure(frame * 2, 2);
      if (readable < 2) break;
      const size_t run = std::min(count - written, readable / 2);
      packFrames(frame, run, channels, out + written * size_t(channels) * 3);
      written += run;
    }
    return written;
  }

private:
  void packFrames(uint64_t frame, size_t count, uint16_t channels, uint8_t* out) const {
    for (size_t f = 0; f < count; ++f) {
      const uint8_t marker = ((frame + f) & 1) ? 0xFA : 0x05;
      for (uint16_t c = 0; c < channels; ++c) {
        const uint8_t* dsd = bytes_.at(c, (frame + f) * 2);
        // 24-bit little-endian: newer byte, older byte, marker.
        *out++ = dsd[1];
        *out++ = dsd[0];
        *out++ = marker;
      }
    }
  }

  DsdByteReader bytes_;
  uint64_t frames_ = 0;
};

class FlacSource final : public FrameSource {
public:
  ~FlacSource() override {
    if (flac_) drflac_close(flac_);
  }
  bool open(const std::string& path, std::string& error) {
    flac_ = drflac_open_file(path.c_str(), nullptr);
    if (!flac_ || flac_->totalPCMFrameCount == 0 || flac_->channels == 0) {
      error = "FLAC open failed";
      return false;
    }
    bits_ = flac_->bitsPerSample <= 16 ? 16 : 24;
    return true;
  }
  uint32_t sampleRate() const override { return flac_->sampleRate; }
  uint16_t channels() const override { return flac_->channels; }
  uint64_t frameCount() const override { return flac_->totalPCMFrameCount; }
  uint16_t bitsPerSample() const override { return bits_; }

  size_t readFloat(uint64_t startFrame, size_t count, float* out) override {
    if (startFrame >= frameCount()) return 0;
    if (startFrame != position_) {
      if (!drflac_seek_to_pcm_frame(flac_, startFrame)) return 0;
      position_ = startFrame;
    }
    buffer_.resize(count * channels());
    const size_t n = size_t(drflac_read_pcm_frames_s32(flac_, count, buffer_.data()));
    position_ += n;
    s32ToFloat(buffer_.data(), n * channels(), out);
    return n;
  }

  size_t readPacked(uint64_t startFrame, size_t count, uint8_t* out) override {
    if (startFrame >= frameCount()) return 0;
    if (startFrame != position_) {
      if (!drflac_seek_to_pcm_frame(flac_, startFrame)) return 0;
      position_ = startFrame;
    }
    buffer_.resize(count * channels());
    const size_t n = size_t(drflac_read_pcm_frames_s32(flac_, count, buffer_.data()));
    position_ += n;
    packS32(buffer_.data(), n * channels(), bits_, out);
    return n;
  }

private:
  drflac* flac_ = nullptr;
  uint16_t bits_ = 24;
  uint64_t position_ = 0;
  std::vector<int32_t> buffer_;
};

class WavSource final : public FrameSource {
public:
  ~WavSource() override {
    if (open_) drwav_uninit(&wav_);
  }
  bool open(const std::string& path, std::string& error) {
    open_ = drwav_init_file(&wav_, path.c_str(), nullptr);
    if (!open_ || wav_.totalPCMFrameCount == 0 || wav_.channels == 0) {
      error = "WAV open failed";
      return false;
    }
    bits_ = wav_.translatedFormatTag == DR_WAVE_FORMAT_PCM && wav_.bitsPerSample <= 16 ? 16 : 24;
    return true;
  }
  uint32_t sampleRate() const override { return wav_.sampleRate; }
  uint16_t channels() const override { return wav_.channels; }
  uint64_t frameCount() const override { return wav_.totalPCMFrameCount; }
  uint16_t bitsPerSample() const override { return bits_; }

  size_t readFloat(uint64_t startFrame, size_t count, float* out) override {
    if (startFrame >= frameCount()) return 0;
    if (startFrame != position_) {
      if (!drwav_seek_to_pcm_frame(&wav_, startFrame)) return 0;
      position_ = startFrame;
    }
    buffer_.resize(count * channels());
    const size_t n = size_t(drwav_read_pcm_frames_s32(&wav_, count, buffer_.data()));
    position_ += n;
    s32ToFloat(buffer_.data(), n * channels(), out);
    return n;
  }

  size_t readPacked(uint64_t startFrame, size_t count, uint8_t* out) override {
    if (startFrame >= frameCount()) return 0;
    if (startFrame != position_) {
      if (!drwav_seek_to_pcm_frame(&wav_, startFrame)) return 0;
      position_ = startFrame;
    }
    buffer_.resize(count * channels());
    const size_t n = size_t(drwav_read_pcm_frames_s32(&wav_, count, buffer_.data()));
    position_ += n;
    packS32(buffer_.data(), n * channels(), bits_, out);
    return n;
  }

private:
  drwav wav_ {};
  bool open_ = false;
  uint16_t bits_ = 24;
  uint64_t position_ = 0;
  std::vector<int32_t> buffer_;
};

class Mp3Source final : public FrameSource {
public:
  ~Mp3Source() override {
    if (open_) drmp3_uninit(&mp3_);
  }
  bool open(const std::string& path, std::string& error) {
    open_ = drmp3_init_file(&mp3_, path.c_str(), nullptr);
    if (open_) frames_ = drmp3_get_pcm_frame_count(&mp3_);
    if (!open_ || frames_ == 0 || mp3_.channels == 0 || !drmp3_seek_to_pcm_frame(&mp3_, 0)) {
      error = "MP3 open failed";
      return false;
    }
    return true;
  }
  uint32_t sampleRate() const override { return mp3_.sampleRate; }
  uint16_t channels() const override { return uint16_t(mp3_.channels); }
  uint64_t frameCount() const override { return frames_; }
  uint16_t bitsPerSample() const override { return 24; }

  size_t readFloat(uint64_t startFrame, size_t count, float* out) override {
    if (startFrame >= frames_) return 0;
    if (startFrame != position_) {
      if (!drmp3_seek_to_pcm_frame(&mp3_, startFrame)) return 0;
      position_ = startFrame;
    }
    const size_t n = size_t(drmp3_read_pcm_frames_f32(&mp3_, count, out));
    position_ += n;
    return n;
  }

  size_t readPacked(uint64_t startFrame, size_t count, uint8_t* out) override {
    if (startFrame >= frames_) return 0;
    if (startFrame != position_) {
      if (!drmp3_seek_to_pcm_frame(&mp3_, startFrame)) return 0;
      position_ = startFrame;
    }
    buffer_.resize(count * channels());
    const size_t n = size_t(drmp3_read_pcm_frames_f32(&mp3_, count, buffer_.data()));
    position_ += n;
    packFloat(buffer_.data(), n, channels(), 24, false, startFrame, out);
    return n;
  }

private:
  drmp3 mp3_ {};
  bool open_ = false;
  uint64_t frames_ = 0;
  uint64_t position_ = 0;
  std::vector<float> buffer_;
};

/** AIFF and uncompressed AIFC (big-endian, 'sowt' little-endian, 'fl32' float). */
class AiffSource final : public FrameSource {
public:
  ~AiffSource() override {
    if (file_) std::fclose(file_);
  }
  bool open(const std::string& path, std::string& error) {
    file_ = std::fopen(path.c_str(), "rb");
    uint8_t form[12];
    if (!file_ || std::fread(form, 1, 12, file_) != 12 || std::memcmp(form, "FORM", 4) != 0 ||
        (std::memcmp(form + 8, "AIFF", 4) != 0 && std::memcmp(form + 8, "AIFC", 4) != 0)) {
      error = "Not an AIFF file";
      return false;
    }
    const bool aifc = std::memcmp(form + 8, "AIFC", 4) == 0;
    uint64_t declaredFrames = 0;
    uint64_t ssndBytes = 0;
    bool haveComm = false;
    uint8_t header[8];
    while (std::fread(header, 1, 8, file_) == 8) {
      const uint32_t size = be32(header + 4);
      const long body = std::ftell(file_);
      if (std::memcmp(header, "COMM", 4) == 0) {
        uint8_t comm[22] {};
        if (std::fread(comm, 1, std::min<uint32_t>(size, 22), file_) < 18) break;
        channels_ = uint16_t((comm[0] << 8) | comm[1]);
        declaredFrames = be32(comm + 2);
        sourceBits_ = uint16_t((comm[6] << 8) | comm[7]);
        rate_ = extendedToRate(comm + 8);
        if (aifc && size >= 22) {
          if (std::memcmp(comm + 18, "sowt", 4) == 0) littleEndian_ = true;
          else if (std::memcmp(comm + 18, "fl32", 4) == 0 || std::memcmp(comm + 18, "FL32", 4) == 0) {
            float_ = true;
            sourceBits_ = 32;
          } else if (std::memcmp(comm + 18, "NONE", 4) != 0 && std::memcmp(comm + 18, "twos", 4) != 0) {
            error = "Compressed AIFC is not supported";
            return false;
          }
        }
        haveComm = true;
      } else if (std::memcmp(header, "SSND", 4) == 0) {
        uint8_t ssnd[8];
        if (std::fread(ssnd, 1, 8, file_) != 8) break;
        dataStart_ = uint64_t(body) + 8 + be32(ssnd);
        ssndBytes = size >= 8 + be32(ssnd) ? size - 8 - be32(ssnd) : 0;
      }
      if (std::fseek(file_, body + long(size) + long(size & 1), SEEK_SET) != 0) break;
    }
    const uint32_t bytes = (sourceBits_ + 7) / 8;
    if (!haveComm || dataStart_ == 0 || channels_ == 0 || rate_ == 0 || bytes == 0 || bytes > 4) {
      error = "AIFF missing COMM/SSND";
      return false;
    }
    blockAlign_ = size_t(bytes) * channels_;
    frames_ = std::min<uint64_t>(declaredFrames, ssndBytes / blockAlign_);
    bits_ = !float_ && sourceBits_ <= 16 ? 16 : 24;
    return frames_ > 0;
  }
  uint32_t sampleRate() const override { return rate_; }
  uint16_t channels() const override { return channels_; }
  uint64_t frameCount() const override { return frames_; }
  uint16_t bitsPerSample() const override { return bits_; }

  size_t readFloat(uint64_t startFrame, size_t count, float* out) override {
    if (startFrame >= frames_) return 0;
    count = size_t(std::min<uint64_t>(count, frames_ - startFrame));
    if (!seek(dataStart_ + startFrame * blockAlign_)) return 0;
    raw_.resize(count * blockAlign_);
    const size_t n = std::fread(raw_.data(), 1, raw_.size(), file_) / blockAlign_;
    const size_t bytes = blockAlign_ / channels_;
    const size_t samples = n * channels_;
    if (float_) {
      for (size_t i = 0; i < samples; ++i) {
        const uint32_t bitsValue = be32(raw_.data() + i * 4);
        std::memcpy(out + i, &bitsValue, 4);
      }
      return n;
    }
    for (size_t i = 0; i < samples; ++i) {
      const uint8_t* p = raw_.data() + i * bytes;
      uint32_t v = 0;
      for (size_t b = 0; b < bytes; ++b) {
        const uint8_t byte = littleEndian_ ? p[bytes - 1 - b] : p[b];
        v |= uint32_t(byte) << (24 - 8 * b);
      }
      out[i] = float(int32_t(v)) * (1.0f / 2147483648.0f);
    }
    return n;
  }

  size_t readPacked(uint64_t startFrame, size_t count, uint8_t* out) override {
    if (startFrame >= frames_) return 0;
    count = size_t(std::min<uint64_t>(count, frames_ - startFrame));
    if (!seek(dataStart_ + startFrame * blockAlign_)) return 0;
    raw_.resize(count * blockAlign_);
    const size_t n = std::fread(raw_.data(), 1, raw_.size(), file_) / blockAlign_;
    const size_t bytes = blockAlign_ / channels_;
    const size_t samples = n * channels_;
    if (float_) {
      floats_.resize(samples);
      for (size_t i = 0; i < samples; ++i) {
        const uint32_t bitsValue = be32(raw_.data() + i * 4);
        std::memcpy(&floats_[i], &bitsValue, 4);
      }
      packFloat(floats_.data(), n, channels_, 24, false, startFrame, out);
      return n;
    }
    ints_.resize(samples);
    for (size_t i = 0; i < samples; ++i) {
      const uint8_t* p = raw_.data() + i * bytes;
      uint32_t v = 0;
      for (size_t b = 0; b < bytes; ++b) {
        const uint8_t byte = littleEndian_ ? p[bytes - 1 - b] : p[b];
        v |= uint32_t(byte) << (24 - 8 * b);
      }
      ints_[i] = int32_t(v);
    }
    packS32(ints_.data(), samples, bits_, out);
    return n;
  }

private:
  static uint32_t be32(const uint8_t* p) {
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | uint32_t(p[3]);
  }
  /** 80-bit IEEE extended sample rate. */
  static uint32_t extendedToRate(const uint8_t* p) {
    const int exponent = ((p[0] & 0x7f) << 8) | p[1];
    uint64_t mantissa = 0;
    for (int i = 0; i < 8; ++i) mantissa = (mantissa << 8) | p[2 + i];
    if (exponent < 16383 || exponent > 16383 + 63) return 0;
    return uint32_t(mantissa >> (63 - (exponent - 16383)));
  }
  bool seek(uint64_t offset) {
#if defined(_WIN32)
    return _fseeki64(file_, int64_t(offset), SEEK_SET) == 0;
#else
    return fseeko(file_, off_t(offset), SEEK_SET) == 0;
#endif
  }

  std::FILE* file_ = nullptr;
  uint32_t rate_ = 0;
  uint16_t channels_ = 0;
  uint16_t sourceBits_ = 0;
  uint16_t bits_ = 24;
  bool littleEndian_ = false;
  bool float_ = false;
  uint64_t dataStart_ = 0;
  size_t blockAlign_ = 0;
  uint64_t frames_ = 0;
  std::vector<uint8_t> raw_;
  std::vector<int32_t> ints_;
  std::vector<float> floats_;
};

#if defined(__APPLE__)
/** ALAC, AAC and anything else Core Audio reads, decoded to float with sample-exact seeks. */
class AppleFileSource final : public FrameSource {
public:
  ~AppleFileSource() override {
    if (file_) ExtAudioFileDispose(file_);
  }
  bool open(const std::string& path, std::string& error) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(
      kCFAllocatorDefault, reinterpret_cast<const UInt8*>(path.c_str()), CFIndex(path.size()), false);
    if (!url) {
      error = "Bad path";
      return false;
    }
    const OSStatus st = ExtAudioFileOpenURL(url, &file_);
    CFRelease(url);
    if (st != noErr || !file_) {
      file_ = nullptr;
      error = "Cannot open audio file";
      return false;
    }
    AudioStreamBasicDescription source {};
    UInt32 size = sizeof(source);
    SInt64 frames = 0;
    UInt32 framesSize = sizeof(frames);
    if (ExtAudioFileGetProperty(file_, kExtAudioFileProperty_FileDataFormat, &size, &source) != noErr ||
        ExtAudioFileGetProperty(file_, kExtAudioFileProperty_FileLengthFrames, &framesSize, &frames) != noErr ||
        source.mChannelsPerFrame == 0 || source.mSampleRate <= 0 || frames <= 0) {
      error = "Cannot read audio format";
      return false;
    }
    channels_ = uint16_t(source.mChannelsPerFrame);
    rate_ = uint32_t(std::lround(source.mSampleRate));
    frames_ = uint64_t(frames);
    const bool alac16 = source.mFormatID == kAudioFormatAppleLossless &&
                        source.mFormatFlags == kAppleLosslessFormatFlag_16BitSourceData;
    const bool pcm16 = source.mFormatID == kAudioFormatLinearPCM &&
                       (source.mFormatFlags & kAudioFormatFlagIsFloat) == 0 && source.mBitsPerChannel <= 16;
    bits_ = alac16 || pcm16 ? 16 : 24;

    AudioStreamBasicDescription client {};
    client.mSampleRate = source.mSampleRate;
    client.mFormatID = kAudioFormatLinearPCM;
    client.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    client.mChannelsPerFrame = channels_;
    client.mBitsPerChannel = 32;
    client.mBytesPerFrame = 4 * channels_;
    client.mFramesPerPacket = 1;
    client.mBytesPerPacket = client.mBytesPerFrame;
    if (ExtAudioFileSetProperty(file_, kExtAudioFileProperty_ClientDataFormat, sizeof(client), &client) != noErr) {
      error = "Cannot decode audio file";
      return false;
    }
    return true;
  }
  uint32_t sampleRate() const override { return rate_; }
  uint16_t channels() const override { return channels_; }
  uint64_t frameCount() const override { return frames_; }
  uint16_t bitsPerSample() const override { return bits_; }

  size_t readFloat(uint64_t startFrame, size_t count, float* out) override {
    if (startFrame >= frames_) return 0;
    if (startFrame != position_) {
      if (ExtAudioFileSeek(file_, SInt64(startFrame)) != noErr) return 0;
      position_ = startFrame;
    }
    size_t done = 0;
    while (done < count) {
      AudioBufferList list {};
      list.mNumberBuffers = 1;
      list.mBuffers[0].mNumberChannels = channels_;
      list.mBuffers[0].mDataByteSize = UInt32((count - done) * channels_ * sizeof(float));
      list.mBuffers[0].mData = out + done * channels_;
      UInt32 frames = UInt32(count - done);
      if (ExtAudioFileRead(file_, &frames, &list) != noErr || frames == 0) break;
      done += frames;
    }
    position_ += done;
    return done;
  }

  size_t readPacked(uint64_t startFrame, size_t count, uint8_t* out) override {
    if (startFrame >= frames_) return 0;
    if (startFrame != position_) {
      if (ExtAudioFileSeek(file_, SInt64(startFrame)) != noErr) return 0;
      position_ = startFrame;
    }
    buffer_.resize(count * channels_);
    size_t done = 0;
    while (done < count) {
      AudioBufferList list {};
      list.mNumberBuffers = 1;
      list.mBuffers[0].mNumberChannels = channels_;
      list.mBuffers[0].mDataByteSize = UInt32((count - done) * channels_ * sizeof(float));
      list.mBuffers[0].mData = buffer_.data() + done * channels_;
      UInt32 frames = UInt32(count - done);
      if (ExtAudioFileRead(file_, &frames, &list) != noErr || frames == 0) break;
      done += frames;
    }
    position_ += done;
    packFloat(buffer_.data(), done, channels_, bits_, false, startFrame, out);
    return done;
  }

private:
  ExtAudioFileRef file_ = nullptr;
  uint32_t rate_ = 0;
  uint16_t channels_ = 0;
  uint16_t bits_ = 24;
  uint64_t frames_ = 0;
  uint64_t position_ = 0;
  std::vector<float> buffer_;
};
#endif

/** Whole file decoded up front (ALAC / AAC through ffmpeg off the Mac). */
class MemorySource final : public FrameSource {
public:
  bool open(const std::string& path, std::string& error) {
    if (!decodePcmFile(path, pcm_, error)) return false;
    if (pcm_.channels == 0 || pcm_.interleaved.empty()) {
      error = "Nothing decoded";
      return false;
    }
    return true;
  }
  uint32_t sampleRate() const override { return pcm_.sampleRate; }
  uint16_t channels() const override { return pcm_.channels; }
  uint64_t frameCount() const override { return pcm_.interleaved.size() / pcm_.channels; }
  uint16_t bitsPerSample() const override { return 24; }

  size_t readFloat(uint64_t startFrame, size_t count, float* out) override {
    if (startFrame >= frameCount()) return 0;
    const size_t n = size_t(std::min<uint64_t>(count, frameCount() - startFrame));
    std::memcpy(out, pcm_.interleaved.data() + startFrame * pcm_.channels, n * pcm_.channels * sizeof(float));
    return n;
  }

  size_t readPacked(uint64_t startFrame, size_t count, uint8_t* out) override {
    if (startFrame >= frameCount()) return 0;
    const size_t n = size_t(std::min<uint64_t>(count, frameCount() - startFrame));
    packFloat(pcm_.interleaved.data() + startFrame * pcm_.channels, n, pcm_.channels, 24, false,
              startFrame, out);
    return n;
  }

private:
  DecodedPcm pcm_;
};

template <typename Source>
std::unique_ptr<FrameSource> tryOpen(const std::string& path, std::string& error) {
  auto source = std::make_unique<Source>();
  if (source->open(path, error)) return source;
  return nullptr;
}

} // namespace

std::unique_ptr<FrameSource> openFrameSource(
    const std::string& path, const FrameSourceOptions& options, std::string& error) {
  if (endsWithCi(path, ".dsf") || endsWithCi(path, ".dff")) {
    if (options.dop) {
      auto source = std::make_unique<DopSource>();
      if (source->open(path, error)) return source;
      return nullptr;
    }
    auto source = std::make_unique<DsdSource>();
    if (source->open(path, options, error)) return source;
    return nullptr;
  }

  std::unique_ptr<FrameSource> source;
  if (endsWithCi(path, ".flac")) source = tryOpen<FlacSource>(path, error);
  else if (endsWithCi(path, ".wav") || endsWithCi(path, ".wave")) source = tryOpen<WavSource>(path, error);
  else if (endsWithCi(path, ".mp3")) source = tryOpen<Mp3Source>(path, error);
  else if (endsWithCi(path, ".aif") || endsWithCi(path, ".aiff") || endsWithCi(path, ".aifc")) {
    source = tryOpen<AiffSource>(path, error);
  }
  if (source) return source;

#if defined(__APPLE__)
  source = tryOpen<AppleFileSource>(path, error);
  if (source) return source;
#endif
  return tryOpen<MemorySource>(path, error);
}
