#include "PcmDecoder.h"

#include <algorithm>
#include <cstdio>
#include <cstring>

#define DR_FLAC_IMPLEMENTATION
#include "../third_party/dr_flac.h"
#define DR_MP3_IMPLEMENTATION
#include "../third_party/dr_mp3.h"
#define DR_WAV_IMPLEMENTATION
#include "../third_party/dr_wav.h"

namespace {

bool endsWithCi(const std::string& s, const char* ext) {
  const size_t n = std::strlen(ext);
  if (s.size() < n) return false;
  for (size_t i = 0; i < n; ++i) {
    const char a = s[s.size() - n + i];
    const char b = ext[i];
    if ((a | 32) != (b | 32)) return false;
  }
  return true;
}

} // namespace

bool decodePcmFile(const std::string& path, DecodedPcm& out, std::string& error) {
  out = {};
  if (endsWithCi(path, ".flac")) {
    unsigned channels = 0, sampleRate = 0;
    drflac_uint64 frames = 0;
    float* samples = drflac_open_file_and_read_pcm_frames_f32(path.c_str(), &channels, &sampleRate, &frames, nullptr);
    if (!samples) {
      error = "FLAC decode failed";
      return false;
    }
    out.channels = static_cast<uint16_t>(channels);
    out.sampleRate = sampleRate;
    out.interleaved.assign(samples, samples + frames * channels);
    drflac_free(samples, nullptr);
    return true;
  }

  if (endsWithCi(path, ".mp3")) {
    drmp3_config cfg {};
    drmp3_uint64 frames = 0;
    float* samples = drmp3_open_file_and_read_pcm_frames_f32(path.c_str(), &cfg, &frames, nullptr);
    if (!samples) {
      error = "MP3 decode failed";
      return false;
    }
    out.channels = cfg.channels;
    out.sampleRate = cfg.sampleRate;
    out.interleaved.assign(samples, samples + frames * cfg.channels);
    drmp3_free(samples, nullptr);
    return true;
  }

  if (endsWithCi(path, ".wav") || endsWithCi(path, ".wave")) {
    drwav_uint64 frames = 0;
    unsigned channels = 0, sampleRate = 0;
    float* samples = drwav_open_file_and_read_pcm_frames_f32(path.c_str(), &channels, &sampleRate, &frames, nullptr);
    if (!samples) {
      error = "WAV decode failed";
      return false;
    }
    out.channels = static_cast<uint16_t>(channels);
    out.sampleRate = sampleRate;
    out.interleaved.assign(samples, samples + frames * channels);
    drwav_free(samples, nullptr);
    return true;
  }

  // AIFF: minimal big-endian PCM reader
  if (endsWithCi(path, ".aiff") || endsWithCi(path, ".aif")) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) {
      error = "Cannot open AIFF";
      return false;
    }
    char form[12];
    if (std::fread(form, 1, 12, f) != 12 || std::memcmp(form, "FORM", 4) != 0) {
      std::fclose(f);
      error = "Not AIFF";
      return false;
    }
    uint16_t channels = 0, bits = 0;
    uint32_t frames = 0, rate = 0;
    long ssndPos = -1;
    uint32_t ssndSize = 0;
    while (!std::feof(f)) {
      char id[4];
      uint8_t szb[4];
      if (std::fread(id, 1, 4, f) != 4 || std::fread(szb, 1, 4, f) != 4) break;
      uint32_t sz = (uint32_t(szb[0]) << 24) | (uint32_t(szb[1]) << 16) | (uint32_t(szb[2]) << 8) | uint32_t(szb[3]);
      if (std::memcmp(id, "COMM", 4) == 0) {
        uint8_t comm[18] {};
        std::fread(comm, 1, std::min<uint32_t>(sz, 18), f);
        if (sz > 18) std::fseek(f, long(sz - 18), SEEK_CUR);
        channels = uint16_t((comm[0] << 8) | comm[1]);
        frames = (uint32_t(comm[2]) << 24) | (uint32_t(comm[3]) << 16) | (uint32_t(comm[4]) << 8) | uint32_t(comm[5]);
        bits = uint16_t((comm[6] << 8) | comm[7]);
        // 80-bit SANE float sample rate — commonly 44100/48000 stored; approximate via IEEE extended
        // For simplicity read integer part from exponent/mantissa common cases:
        const int exp = ((comm[8] & 0x7f) << 8) | comm[9];
        uint64_t mant = 0;
        for (int i = 0; i < 8; ++i) mant = (mant << 8) | comm[10 + i];
        if (exp >= 16383 && exp < 16446) {
          rate = uint32_t(mant >> (63 - (exp - 16383)));
        } else {
          rate = 44100;
        }
        if (sz & 1) std::fseek(f, 1, SEEK_CUR);
      } else if (std::memcmp(id, "SSND", 4) == 0) {
        ssndPos = std::ftell(f) + 8; // skip offset/blockSize
        ssndSize = sz > 8 ? sz - 8 : 0;
        std::fseek(f, long(sz), SEEK_CUR);
        if (sz & 1) std::fseek(f, 1, SEEK_CUR);
      } else {
        std::fseek(f, long(sz + (sz & 1)), SEEK_CUR);
      }
    }
    if (!channels || !rate || ssndPos < 0) {
      std::fclose(f);
      error = "AIFF missing COMM/SSND";
      return false;
    }
    std::fseek(f, ssndPos, SEEK_SET);
    std::vector<uint8_t> raw(ssndSize);
    std::fread(raw.data(), 1, ssndSize, f);
    std::fclose(f);
    const size_t bytesPerSample = bits / 8;
    const size_t sampleCount = bytesPerSample ? std::min(size_t(frames) * channels, raw.size() / bytesPerSample) : 0;
    out.channels = channels;
    out.sampleRate = rate;
    out.interleaved.resize(sampleCount);
    for (size_t i = 0; i < sampleCount; ++i) {
      const size_t o = i * bytesPerSample;
      int32_t v = 0;
      if (bits == 16) {
        v = int16_t((raw[o] << 8) | raw[o + 1]);
        out.interleaved[i] = v / 32768.0f;
      } else if (bits == 24) {
        v = (int32_t(raw[o]) << 16) | (int32_t(raw[o + 1]) << 8) | int32_t(raw[o + 2]);
        if (v & 0x800000) v |= ~0xFFFFFF;
        out.interleaved[i] = v / 8388608.0f;
      } else if (bits == 32) {
        v = (int32_t(raw[o]) << 24) | (int32_t(raw[o + 1]) << 16) | (int32_t(raw[o + 2]) << 8) | int32_t(raw[o + 3]);
        out.interleaved[i] = v / 2147483648.0f;
      }
    }
    return !out.interleaved.empty();
  }

  // ALAC / AAC / M4A via ffmpeg when available (Linux; Mac uses ExtAudioFile in MacPlayer)
  if (endsWithCi(path, ".m4a") || endsWithCi(path, ".mp4") || endsWithCi(path, ".alac") ||
      endsWithCi(path, ".aac")) {
    std::string quoted = "'";
    for (char c : path) {
      if (c == '\'') quoted += "'\\''";
      else quoted += c;
    }
    quoted += "'";
    char cmd[4096];
    std::snprintf(
      cmd,
      sizeof(cmd),
      "ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate,channels "
      "-of csv=p=0:s=x %s 2>/dev/null",
      quoted.c_str()
    );
    FILE* probe = popen(cmd, "r");
    unsigned rate = 0, channels = 0;
    if (probe) {
      if (std::fscanf(probe, "%ux%u", &rate, &channels) != 2) {
        rate = 0;
        channels = 0;
      }
      pclose(probe);
    }
    if (!rate || !channels) {
      error = "ALAC/AAC requires ffmpeg/ffprobe";
      return false;
    }
    std::snprintf(
      cmd,
      sizeof(cmd),
      "ffmpeg -v error -i %s -f f32le -acodec pcm_f32le -",
      quoted.c_str()
    );
    FILE* pipe = popen(cmd, "r");
    if (!pipe) {
      error = "ffmpeg not available for ALAC/AAC";
      return false;
    }
    std::vector<float> samples;
    float buf[4096];
    while (true) {
      const size_t n = std::fread(buf, sizeof(float), 4096, pipe);
      if (n == 0) break;
      samples.insert(samples.end(), buf, buf + n);
    }
    const int status = pclose(pipe);
    if (status != 0 || samples.empty()) {
      error = "ffmpeg ALAC/AAC decode failed";
      return false;
    }
    out.channels = static_cast<uint16_t>(channels);
    out.sampleRate = rate;
    out.interleaved = std::move(samples);
    return true;
  }

  error = "Unsupported PCM format";
  return false;
}
