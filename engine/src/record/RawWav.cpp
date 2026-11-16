#include "RawWav.h"

#include <algorithm>
#include <cstring>
#include <vector>

#if defined(_WIN32)
#define harbor_fseek _fseeki64
#define harbor_ftell _ftelli64
#else
#define harbor_fseek fseeko
#define harbor_ftell ftello
#endif

namespace {

constexpr uint64_t kHeaderBytes = 104; // RIFF 12 + JUNK/ds64 36 + fmt 48 + data 8

void put16(std::vector<uint8_t>& o, uint32_t v) {
  o.push_back(uint8_t(v));
  o.push_back(uint8_t(v >> 8));
}
void put32(std::vector<uint8_t>& o, uint32_t v) {
  for (int i = 0; i < 4; ++i) o.push_back(uint8_t(v >> (8 * i)));
}
void put64(std::vector<uint8_t>& o, uint64_t v) {
  for (int i = 0; i < 8; ++i) o.push_back(uint8_t(v >> (8 * i)));
}
void tag(std::vector<uint8_t>& o, const char* t) { o.insert(o.end(), t, t + 4); }

uint32_t get16(const uint8_t* p) { return uint32_t(p[0]) | (uint32_t(p[1]) << 8); }
uint32_t get32(const uint8_t* p) { return get16(p) | (get16(p + 2) << 16); }
uint64_t get64(const uint8_t* p) { return uint64_t(get32(p)) | (uint64_t(get32(p + 4)) << 32); }

} // namespace

RawWavWriter::~RawWavWriter() {
  if (file_) close();
}

bool RawWavWriter::open(const std::string& path, uint32_t sampleRate, int channels, int validBits,
                        std::string& error) {
  file_ = std::fopen(path.c_str(), "wb");
  if (!file_) {
    error = "Cannot create " + path;
    return false;
  }
  std::setvbuf(file_, nullptr, _IOFBF, 1 << 20);
  rate_ = sampleRate;
  channels_ = channels;
  validBits_ = validBits;
  if (!writeHeader()) {
    error = "Cannot write " + path;
    return false;
  }
  return true;
}

bool RawWavWriter::writeHeader() {
  const uint32_t blockAlign = uint32_t(channels_) * 4;
  const uint64_t dataBytes = frames_ * blockAlign;
  const uint64_t riffBytes = kHeaderBytes - 8 + dataBytes;
  const bool rf64 = riffBytes > 0xFFFFFFFFull;
  std::vector<uint8_t> h;
  tag(h, rf64 ? "RF64" : "RIFF");
  put32(h, rf64 ? 0xFFFFFFFFu : uint32_t(riffBytes));
  tag(h, "WAVE");
  if (rf64) {
    tag(h, "ds64");
    put32(h, 28);
    put64(h, riffBytes);
    put64(h, dataBytes);
    put64(h, frames_);
    put32(h, 0);
  } else {
    tag(h, "JUNK");
    put32(h, 28);
    h.insert(h.end(), 28, 0);
  }
  tag(h, "fmt ");
  put32(h, 40);
  put16(h, 0xFFFE);
  put16(h, uint32_t(channels_));
  put32(h, rate_);
  put32(h, rate_ * blockAlign);
  put16(h, blockAlign);
  put16(h, 32);
  put16(h, 22);
  put16(h, uint32_t(validBits_));
  put32(h, channels_ == 2 ? 0x3 : 0);
  static const uint8_t kPcmGuid[16] = {0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
                                       0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71};
  h.insert(h.end(), kPcmGuid, kPcmGuid + 16);
  tag(h, "data");
  put32(h, rf64 ? 0xFFFFFFFFu : uint32_t(dataBytes));
  if (harbor_fseek(file_, 0, SEEK_SET) != 0) return false;
  if (std::fwrite(h.data(), 1, h.size(), file_) != h.size()) return false;
  return harbor_fseek(file_, 0, SEEK_END) == 0;
}

bool RawWavWriter::write(const int32_t* interleaved, size_t frames) {
  if (!file_ || failed_) return false;
  const size_t samples = frames * size_t(channels_);
  uint8_t buf[4096];
  size_t done = 0;
  while (done < samples) {
    const size_t chunk = std::min<size_t>(samples - done, sizeof(buf) / 4);
    for (size_t i = 0; i < chunk; ++i) {
      const uint32_t s = uint32_t(interleaved[done + i]);
      buf[i * 4] = uint8_t(s);
      buf[i * 4 + 1] = uint8_t(s >> 8);
      buf[i * 4 + 2] = uint8_t(s >> 16);
      buf[i * 4 + 3] = uint8_t(s >> 24);
    }
    if (std::fwrite(buf, 4, chunk, file_) != chunk) {
      failed_ = true;
      return false;
    }
    done += chunk;
  }
  frames_ += frames;
  return true;
}

bool RawWavWriter::sync() {
  if (!file_ || failed_) return false;
  if (!writeHeader() || std::fflush(file_) != 0) {
    failed_ = true;
    return false;
  }
  return true;
}

bool RawWavWriter::close() {
  if (!file_) return false;
  bool ok = !failed_ && writeHeader();
  if (std::fclose(file_) != 0) ok = false;
  file_ = nullptr;
  return ok;
}

WavReader::~WavReader() { close(); }

void WavReader::close() {
  if (file_) std::fclose(file_);
  file_ = nullptr;
}

bool WavReader::open(const std::string& path, std::string& error) {
  file_ = std::fopen(path.c_str(), "rb");
  if (!file_) {
    error = "Cannot open " + path;
    return false;
  }
  uint8_t head[12];
  if (std::fread(head, 1, 12, file_) != 12 || (std::memcmp(head, "RIFF", 4) && std::memcmp(head, "RF64", 4)) ||
      std::memcmp(head + 8, "WAVE", 4)) {
    error = "Not a WAV file";
    return false;
  }
  uint64_t ds64Data = 0;
  bool haveFmt = false;
  uint64_t dataBytes = 0;
  for (;;) {
    uint8_t ch[8];
    if (std::fread(ch, 1, 8, file_) != 8) break;
    const uint32_t size = get32(ch + 4);
    const int64_t at = harbor_ftell(file_);
    if (!std::memcmp(ch, "ds64", 4) && size >= 24) {
      uint8_t d[24];
      if (std::fread(d, 1, 24, file_) != 24) break;
      ds64Data = get64(d + 8);
    } else if (!std::memcmp(ch, "fmt ", 4) && size >= 16) {
      uint8_t f[40] = {};
      const size_t n = size < 40 ? size : 40;
      if (std::fread(f, 1, n, file_) != n) break;
      const uint32_t formatTag = get16(f);
      channels_ = int(get16(f + 2));
      rate_ = get32(f + 4);
      containerBits_ = int(get16(f + 14));
      validBits_ = containerBits_;
      if (formatTag == 0xFFFE && n >= 26) {
        const int valid = int(get16(f + 18));
        if (valid > 0 && valid <= containerBits_) validBits_ = valid;
        if (n >= 26 && get16(f + 24) != 1) {
          error = "WAV is not integer PCM";
          return false;
        }
      } else if (formatTag != 1) {
        error = "WAV is not integer PCM";
        return false;
      }
      haveFmt = true;
    } else if (!std::memcmp(ch, "data", 4)) {
      dataOffset_ = uint64_t(at);
      dataBytes = size == 0xFFFFFFFFu && ds64Data ? ds64Data : size;
      break;
    }
    if (harbor_fseek(file_, at + int64_t(size) + (size & 1), SEEK_SET) != 0) break;
  }
  if (!haveFmt || !dataOffset_ || channels_ < 1 || channels_ > 8 ||
      (containerBits_ != 16 && containerBits_ != 24 && containerBits_ != 32)) {
    error = "Unsupported WAV";
    return false;
  }
  // A take cut off before its header was updated: the data runs to the end of the file.
  harbor_fseek(file_, 0, SEEK_END);
  const uint64_t fileBytes = uint64_t(harbor_ftell(file_));
  const uint64_t available = fileBytes > dataOffset_ ? fileBytes - dataOffset_ : 0;
  if (dataBytes == 0 || dataBytes == 0xFFFFFFFFu || dataBytes > available) dataBytes = available;
  frames_ = dataBytes / (uint64_t(channels_) * uint64_t(containerBits_ / 8));
  return true;
}

size_t WavReader::read(uint64_t start, size_t frames, int32_t* out) {
  if (!file_ || start >= frames_) return 0;
  if (frames > frames_ - start) frames = size_t(frames_ - start);
  const size_t bytesPer = size_t(containerBits_ / 8);
  const size_t blockAlign = bytesPer * size_t(channels_);
  if (harbor_fseek(file_, int64_t(dataOffset_ + start * blockAlign), SEEK_SET) != 0) return 0;
  buffer_.resize(frames * blockAlign);
  const size_t got = std::fread(&buffer_[0], blockAlign, frames, file_);
  const uint8_t* p = reinterpret_cast<const uint8_t*>(buffer_.data());
  const size_t samples = got * size_t(channels_);
  for (size_t i = 0; i < samples; ++i, p += bytesPer) {
    uint32_t v;
    if (bytesPer == 2) v = (uint32_t(p[0]) << 16) | (uint32_t(p[1]) << 24);
    else if (bytesPer == 3) v = (uint32_t(p[0]) << 8) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 24);
    else v = get32(p);
    out[i] = int32_t(v);
  }
  return got;
}
