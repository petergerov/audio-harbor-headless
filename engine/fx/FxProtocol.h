#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

/**
 * The pipe between the engine and harbor-fx. Every message is a frame:
 *   [u32 length of type + body, little-endian][u8 type][body]
 * The engine sends one request and reads one reply before the next, so there is no
 * multiplexing. Audio is float32, interleaved, at the rate and channel count of the last
 * Prepare. Every reply starts with the chain's status: u32 latency in frames, u8 flags.
 */
namespace fxproto {

enum Type : uint8_t {
  Prepare = 0x01,  // u32 rate, u32 channels, u32 max block
  Process = 0x02,  // u32 frames, floats
  Reset = 0x03,    // —
  Control = 0x04,  // JSON

  StatusReply = 0x81,   // status
  AudioReply = 0x82,    // status, u32 frames, floats
  ControlReply = 0x84,  // status, JSON
};

/** Inserts are loaded: playback goes through harbor-fx (even when every insert is bypassed). */
constexpr uint8_t kEngaged = 1;
/** At least one loaded insert is in circuit: the plugins shape the sound. */
constexpr uint8_t kProcessing = 2;

constexpr size_t kStatusBytes = 5;
/** Larger frames are a broken pipe, not a message. */
constexpr uint32_t kMaxFrame = 64u << 20;

struct Status {
  uint32_t latency = 0;
  uint8_t flags = 0;
};

inline void putU32(std::vector<uint8_t>& out, uint32_t v) {
  for (int i = 0; i < 4; ++i) out.push_back(uint8_t(v >> (8 * i)));
}

inline uint32_t getU32(const uint8_t* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}

inline void putStatus(std::vector<uint8_t>& out, const Status& s) {
  putU32(out, s.latency);
  out.push_back(s.flags);
}

inline Status getStatus(const uint8_t* p) {
  return Status {getU32(p), p[4]};
}

/** A frame header for `body` bytes of type `type`. */
inline std::vector<uint8_t> header(uint8_t type, size_t body) {
  std::vector<uint8_t> out;
  putU32(out, uint32_t(body + 1));
  out.push_back(type);
  return out;
}

inline bool writeAll(int fd, const void* data, size_t n) {
  const auto* p = static_cast<const uint8_t*>(data);
  while (n > 0) {
#if defined(_WIN32)
    const int w = _write(fd, p, unsigned(n > 1u << 30 ? 1u << 30 : n));
#else
    const ssize_t w = ::write(fd, p, n);
#endif
    if (w <= 0) return false;
    p += w;
    n -= size_t(w);
  }
  return true;
}

inline bool readAll(int fd, void* data, size_t n) {
  auto* p = static_cast<uint8_t*>(data);
  while (n > 0) {
#if defined(_WIN32)
    const int r = _read(fd, p, unsigned(n > 1u << 30 ? 1u << 30 : n));
#else
    const ssize_t r = ::read(fd, p, n);
#endif
    if (r <= 0) return false;
    p += r;
    n -= size_t(r);
  }
  return true;
}

/** One frame: the header, then the body pieces as they are. */
inline bool writeFrame(int fd, uint8_t type, const std::vector<std::pair<const void*, size_t>>& parts) {
  size_t body = 0;
  for (const auto& part : parts) body += part.second;
  const auto head = header(type, body);
  if (!writeAll(fd, head.data(), head.size())) return false;
  for (const auto& part : parts) {
    if (part.second && !writeAll(fd, part.first, part.second)) return false;
  }
  return true;
}

/** Reads one frame into type and body; false on end of pipe or a broken frame. */
inline bool readFrame(int fd, uint8_t& type, std::vector<uint8_t>& body) {
  uint8_t head[5];
  if (!readAll(fd, head, sizeof(head))) return false;
  const uint32_t len = getU32(head);
  if (len < 1 || len > kMaxFrame) return false;
  type = head[4];
  body.resize(len - 1);
  return body.empty() || readAll(fd, body.data(), body.size());
}

} // namespace fxproto
