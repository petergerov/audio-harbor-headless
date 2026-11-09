#include "AlacReader.h"

#include <algorithm>
#include <cstring>
#include <utility>

#include "alac/ALACBitUtilities.h"
#include "alac/ALACDecoder.h"

namespace {

/** The ALACSpecificConfig: 24 bytes, big-endian. */
constexpr size_t kConfigSize = 24;
/** moov holds only the tables; anything this large is not an audio file we read. */
constexpr uint64_t kMaxMoovBytes = 64ull << 20;
/** No ALAC packet comes near this (4096 frames × 8 channels × 32 bits is 128 KB). */
constexpr uint32_t kMaxPacketBytes = 16u << 20;

int seek64(std::FILE* f, uint64_t offset) {
#if defined(_WIN32)
  return _fseeki64(f, static_cast<__int64>(offset), SEEK_SET);
#else
  return fseeko(f, static_cast<off_t>(offset), SEEK_SET);
#endif
}

uint64_t fileSize(std::FILE* f) {
#if defined(_WIN32)
  if (_fseeki64(f, 0, SEEK_END) != 0) return 0;
  const __int64 end = _ftelli64(f);
#else
  if (fseeko(f, 0, SEEK_END) != 0) return 0;
  const off_t end = ftello(f);
#endif
  return end > 0 ? uint64_t(end) : 0;
}

uint32_t be32(const uint8_t* p) {
  return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3];
}
uint64_t be64(const uint8_t* p) { return (uint64_t(be32(p)) << 32) | be32(p + 4); }
uint16_t be16(const uint8_t* p) { return uint16_t((p[0] << 8) | p[1]); }

/**
 * Where each ALAC channel goes in the WAV / FLAC order the engine uses (L R C LFE Ls Rs …).
 * ALAC's own orders, per channel count (ALACAudioTypes.h): C | L R | C L R | C L R Cs |
 * C L R Ls Rs | C L R Ls Rs LFE | C L R Ls Rs Cs LFE | C Lc Rc L R Ls Rs LFE.
 */
constexpr uint8_t kWavPosition[8][8] = {
    {0},
    {0, 1},
    {2, 0, 1},
    {2, 0, 1, 3},
    {2, 0, 1, 3, 4},
    {2, 0, 1, 4, 5, 3},
    {2, 0, 1, 4, 5, 6, 3},
    {2, 6, 7, 0, 1, 4, 5, 3},
};

/** A box inside a buffer: its type and payload (after the header). */
struct Box {
  char type[5] = {0};
  const uint8_t* data = nullptr;
  size_t size = 0;
};

/** The boxes directly inside [begin, end); false when one runs past the end. */
bool children(const uint8_t* begin, const uint8_t* end, std::vector<Box>& out) {
  out.clear();
  const uint8_t* p = begin;
  while (end - p >= 8) {
    uint64_t size = be32(p);
    size_t header = 8;
    if (size == 1) {
      if (end - p < 16) return false;
      size = be64(p + 8);
      header = 16;
    } else if (size == 0) {
      size = uint64_t(end - p);
    }
    if (size < header || size > uint64_t(end - p)) return false;
    Box box;
    std::memcpy(box.type, p + 4, 4);
    box.data = p + header;
    box.size = size_t(size - header);
    out.push_back(box);
    p += size;
  }
  return true;
}

const Box* find(const std::vector<Box>& boxes, const char* type) {
  for (const Box& b : boxes) {
    if (std::memcmp(b.type, type, 4) == 0) return &b;
  }
  return nullptr;
}

/** What one audio track's tables say. */
struct Track {
  bool alac = false;
  bool otherCodec = false;
  uint8_t config[kConfigSize] = {0};
  uint32_t entryRate = 0;
  uint32_t timescale = 0;
  std::vector<uint32_t> sizes;
  std::vector<uint64_t> chunkOffsets;
  std::vector<std::pair<uint32_t, uint32_t>> stsc; // first chunk (1-based), samples per chunk
  std::vector<std::pair<uint32_t, uint32_t>> stts; // sample count, delta
};

/** stsd: the first entry's codec; for ALAC its 24-byte config from the inner `alac` box. */
bool readStsd(const Box& stsd, Track& t) {
  if (stsd.size < 8) return false;
  const uint32_t entries = be32(stsd.data + 4);
  if (entries == 0) return false;
  std::vector<Box> list;
  if (!children(stsd.data + 8, stsd.data + stsd.size, list) || list.empty()) return false;
  const Box& entry = list.front();
  if (std::memcmp(entry.type, "alac", 4) != 0) {
    t.otherCodec = true;
    return true;
  }
  // AudioSampleEntry: 8 bytes (reserved, data reference), then version 0 / 1 / 2 (QuickTime
  // adds 16 / 36 bytes) and the 20 bytes every version has; the boxes follow.
  if (entry.size < 28) return false;
  const uint16_t version = be16(entry.data + 8);
  const size_t fixed = 28 + (version == 1 ? 16 : version == 2 ? 36 : 0);
  if (version == 0 || version == 1) t.entryRate = be32(entry.data + 24) >> 16;
  if (entry.size >= fixed) {
    std::vector<Box> inner;
    if (children(entry.data + fixed, entry.data + entry.size, inner)) {
      const Box* cookie = find(inner, "alac");
      // A full box: version and flags, then the config.
      if (cookie && cookie->size >= 4 + kConfigSize) {
        std::memcpy(t.config, cookie->data + 4, kConfigSize);
        t.alac = true;
        return true;
      }
    }
  }
  return false;
}

template <typename Read>
bool readTable(const Box& box, size_t entrySize, size_t prefix, Read read) {
  if (box.size < prefix + 4) return false;
  const uint32_t count = be32(box.data + prefix);
  if (uint64_t(count) * entrySize > box.size - prefix - 4) return false;
  const uint8_t* p = box.data + prefix + 4;
  for (uint32_t i = 0; i < count; ++i, p += entrySize) read(p);
  return true;
}

/** stbl of an audio track: codec, packet sizes, chunks, durations. */
bool readStbl(const Box& stbl, Track& t) {
  std::vector<Box> boxes;
  if (!children(stbl.data, stbl.data + stbl.size, boxes)) return false;
  const Box* stsd = find(boxes, "stsd");
  if (!stsd || !readStsd(*stsd, t)) return false;
  if (!t.alac) return true;

  const Box* stsz = find(boxes, "stsz");
  if (!stsz || stsz->size < 12) return false;
  const uint32_t fixedSize = be32(stsz->data + 4);
  const uint32_t samples = be32(stsz->data + 8);
  if (fixedSize) {
    t.sizes.assign(samples, fixedSize);
  } else if (!readTable(*stsz, 4, 8, [&](const uint8_t* p) { t.sizes.push_back(be32(p)); })) {
    return false;
  }

  const Box* stsc = find(boxes, "stsc");
  if (!stsc || !readTable(*stsc, 12, 4, [&](const uint8_t* p) {
        t.stsc.emplace_back(be32(p), be32(p + 4));
      })) {
    return false;
  }
  if (const Box* stco = find(boxes, "stco")) {
    if (!readTable(*stco, 4, 4, [&](const uint8_t* p) { t.chunkOffsets.push_back(be32(p)); })) return false;
  } else if (const Box* co64 = find(boxes, "co64")) {
    if (!readTable(*co64, 8, 4, [&](const uint8_t* p) { t.chunkOffsets.push_back(be64(p)); })) return false;
  } else {
    return false;
  }
  const Box* stts = find(boxes, "stts");
  if (!stts || !readTable(*stts, 8, 4, [&](const uint8_t* p) {
        t.stts.emplace_back(be32(p), be32(p + 4));
      })) {
    return false;
  }
  return true;
}

/** A trak whose handler is `soun`: its tables; false for other tracks or broken ones. */
bool readTrak(const Box& trak, Track& t) {
  std::vector<Box> trakBoxes, mdiaBoxes, minfBoxes;
  if (!children(trak.data, trak.data + trak.size, trakBoxes)) return false;
  const Box* mdia = find(trakBoxes, "mdia");
  if (!mdia || !children(mdia->data, mdia->data + mdia->size, mdiaBoxes)) return false;
  const Box* hdlr = find(mdiaBoxes, "hdlr");
  if (!hdlr || hdlr->size < 12 || std::memcmp(hdlr->data + 8, "soun", 4) != 0) return false;
  if (const Box* mdhd = find(mdiaBoxes, "mdhd")) {
    if (mdhd->size >= 24) t.timescale = be32(mdhd->data + (mdhd->data[0] == 1 ? 20 : 12));
  }
  const Box* minf = find(mdiaBoxes, "minf");
  if (!minf || !children(minf->data, minf->data + minf->size, minfBoxes)) return false;
  const Box* stbl = find(minfBoxes, "stbl");
  return stbl && readStbl(*stbl, t);
}

} // namespace

AlacReader::AlacReader() = default;

AlacReader::~AlacReader() {
  if (file_) std::fclose(file_);
}

bool AlacReader::open(const std::string& path, std::string& error, bool& notAlac) {
  notAlac = false;
  file_ = std::fopen(path.c_str(), "rb");
  if (!file_) {
    error = "Cannot open file";
    return false;
  }
  const uint64_t length = fileSize(file_);

  // The top-level boxes, as far as moov; its contents are read whole (only the tables).
  std::vector<uint8_t> moov;
  uint64_t at = 0;
  while (at + 8 <= length) {
    uint8_t head[16];
    if (seek64(file_, at) != 0 || std::fread(head, 1, 8, file_) != 8) break;
    uint64_t size = be32(head);
    uint64_t header = 8;
    if (size == 1) {
      if (std::fread(head + 8, 1, 8, file_) != 8) break;
      size = be64(head + 8);
      header = 16;
    } else if (size == 0) {
      size = length - at;
    }
    if (size < header || at + size > length) break;
    if (std::memcmp(head + 4, "moov", 4) == 0) {
      if (size - header > kMaxMoovBytes) break;
      moov.resize(size_t(size - header));
      if (std::fread(moov.data(), 1, moov.size(), file_) != moov.size()) moov.clear();
      break;
    }
    at += size;
  }
  if (moov.empty()) {
    error = "Not an MP4 / M4A file (no moov box)";
    return false;
  }

  std::vector<Box> moovBoxes;
  if (!children(moov.data(), moov.data() + moov.size(), moovBoxes)) {
    error = "Broken MP4 boxes";
    return false;
  }
  Track track;
  bool foundAudio = false;
  for (const Box& box : moovBoxes) {
    if (std::memcmp(box.type, "trak", 4) != 0) continue;
    Track t;
    if (!readTrak(box, t)) continue;
    foundAudio = true;
    if (t.alac) {
      track = std::move(t);
      break;
    }
    if (t.otherCodec) notAlac = true;
  }
  if (!track.alac) {
    error = foundAudio && notAlac ? "Not ALAC" : "No ALAC audio track";
    if (!foundAudio) notAlac = false;
    return false;
  }
  notAlac = false;

  // The codec's own description of the stream.
  const uint8_t* c = track.config;
  frameLength_ = be32(c);
  bitDepth_ = c[5];
  channels_ = c[9];
  sampleRate_ = be32(c + 20);
  if (sampleRate_ == 0) sampleRate_ = track.entryRate;
  if (frameLength_ == 0 || frameLength_ > (1u << 20) || channels_ == 0 || channels_ > 8 ||
      (bitDepth_ != 16 && bitDepth_ != 20 && bitDepth_ != 24 && bitDepth_ != 32) || sampleRate_ == 0 ||
      sampleRate_ > 768000) {
    error = "Unsupported ALAC stream";
    return false;
  }

  // Where every packet is: chunks hold runs of packets, stsc says how many per chunk.
  const size_t packets = track.sizes.size();
  if (packets == 0 || track.stsc.empty() || track.chunkOffsets.empty()) {
    error = "ALAC track without packets";
    return false;
  }
  offsets_.reserve(packets);
  sizes_ = track.sizes;
  size_t packet = 0;
  for (size_t run = 0; run < track.stsc.size() && packet < packets; ++run) {
    const uint32_t first = track.stsc[run].first;
    const uint32_t last = run + 1 < track.stsc.size() ? track.stsc[run + 1].first - 1
                                                       : uint32_t(track.chunkOffsets.size());
    const uint32_t perChunk = track.stsc[run].second;
    if (first == 0 || last > track.chunkOffsets.size()) break;
    for (uint32_t chunk = first; chunk <= last && packet < packets; ++chunk) {
      uint64_t offset = track.chunkOffsets[chunk - 1];
      for (uint32_t i = 0; i < perChunk && packet < packets; ++i, ++packet) {
        offsets_.push_back(offset);
        offset += sizes_[packet];
      }
    }
  }
  if (offsets_.size() != packets) {
    error = "Broken ALAC sample table";
    return false;
  }
  for (size_t i = 0; i < packets; ++i) {
    if (sizes_[i] == 0 || sizes_[i] > kMaxPacketBytes || offsets_[i] + sizes_[i] > length) {
      error = "ALAC packet outside the file";
      return false;
    }
  }

  // Each packet's first frame, from the durations (in the track's timescale).
  const uint32_t timescale = track.timescale ? track.timescale : sampleRate_;
  starts_.reserve(packets);
  uint64_t frame = 0;
  for (const auto& [count, delta] : track.stts) {
    const uint64_t frames = timescale == sampleRate_ ? delta : uint64_t(delta) * sampleRate_ / timescale;
    for (uint32_t i = 0; i < count && starts_.size() < packets; ++i) {
      starts_.push_back(frame);
      frame += frames;
    }
  }
  // Durations missing for the last packets: full packets.
  while (starts_.size() < packets) {
    starts_.push_back(frame);
    frame += frameLength_;
  }
  frameCount_ = frame;
  if (frameCount_ == 0) {
    error = "Empty ALAC track";
    return false;
  }

  // The decoder trusts the cookie's length: hand it a padded copy.
  std::vector<uint8_t> cookie(kConfigSize + 64, 0);
  std::memcpy(cookie.data(), track.config, kConfigSize);
  decoder_ = std::make_unique<ALACDecoder>();
  if (decoder_->Init(cookie.data(), uint32_t(kConfigSize)) != 0) {
    error = "ALAC decoder refused the stream";
    return false;
  }
  // Room for the largest packet a frame can need (an uncompressed one), so a broken packet
  // cannot make the decoder read past the buffer.
  const size_t rawBytes = size_t(frameLength_) * channels_ * 4;
  raw_.assign(rawBytes + 64, 0);
  pcm_.assign(size_t(frameLength_) * channels_, 0);
  return true;
}

bool AlacReader::decodePacket(size_t index) {
  const uint32_t size = sizes_[index];
  const size_t room = std::max<size_t>(size, raw_.size()) + 64;
  if (packet_.size() < room) packet_.resize(room);
  std::fill(packet_.begin() + size, packet_.begin() + room, uint8_t(0));
  if (seek64(file_, offsets_[index]) != 0 || std::fread(packet_.data(), 1, size, file_) != size) return false;

  BitBuffer bits;
  BitBufferInit(&bits, packet_.data(), size);
  uint32_t decoded = 0;
  if (decoder_->Decode(&bits, raw_.data(), frameLength_, channels_, &decoded) != 0) return false;

  // The tables say how many frames the packet holds (the last one is short).
  const uint64_t next = index + 1 < starts_.size() ? starts_[index + 1] : frameCount_;
  const size_t frames = size_t(std::min<uint64_t>(decoded, next - starts_[index]));
  // Left-justified, and from ALAC's channel order into the engine's.
  const unsigned ch = channels_;
  const uint8_t* position = kWavPosition[ch - 1];
  const uint8_t* r = raw_.data();
  for (size_t f = 0; f < frames; ++f) {
    int32_t* frameOut = pcm_.data() + f * ch;
    for (unsigned c = 0; c < ch; ++c) {
      int32_t v;
      switch (bitDepth_) {
        case 16: {
          int16_t s16;
          std::memcpy(&s16, r, 2);
          v = int32_t(uint32_t(int32_t(s16)) << 16);
          r += 2;
          break;
        }
        case 20: // left-aligned in 24 bits by the decoder
        case 24:
          // Three bytes, low first (the decoder writes host order; every target is little-endian).
          v = int32_t((uint32_t(r[0]) << 8) | (uint32_t(r[1]) << 16) | (uint32_t(r[2]) << 24));
          r += 3;
          break;
        default: // 32
          std::memcpy(&v, r, 4);
          r += 4;
          break;
      }
      frameOut[position[c]] = v;
    }
  }
  current_ = index;
  currentFrames_ = frames;
  return true;
}

size_t AlacReader::readS32(uint64_t startFrame, size_t count, int32_t* out) {
  size_t done = 0;
  while (done < count) {
    const uint64_t frame = startFrame + done;
    if (frame >= frameCount_) break;
    const size_t index = size_t(std::upper_bound(starts_.begin(), starts_.end(), frame) - starts_.begin()) - 1;
    if (index != current_ && !decodePacket(index)) break;
    const uint64_t within = frame - starts_[index];
    if (within >= currentFrames_) break;
    const size_t n = size_t(std::min<uint64_t>(currentFrames_ - within, count - done));
    std::memcpy(out + done * channels_, pcm_.data() + within * channels_, n * channels_ * sizeof(int32_t));
    done += n;
  }
  return done;
}
