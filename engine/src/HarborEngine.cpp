#include "HarborEngine.h"
#include "Player.h"

#include <algorithm>
#include <cstring>
#include <memory>
#include <mutex>

namespace {
std::unique_ptr<IPlayer> g_player;
HarborEventCallback g_cb = nullptr;
void* g_user = nullptr;
std::mutex g_mutex;
std::string g_deviceUid;
bool g_hasDevice = false;
HarborOutputMode g_mode = HARBOR_MODE_SHARED;
int g_dsdLevel = 3;

void forwardEvent(const char* event, const char* json) {
  if (g_cb) g_cb(event, json, g_user);
}

void applyStoredOutputLocked() {
  if (!g_player) return;
  if (g_hasDevice) g_player->setDevice(&g_deviceUid);
  else g_player->setDevice(nullptr);
  g_player->setOutputMode(g_mode);
  g_player->setDsdPcmLevel(g_dsdLevel);
}
} // namespace

const char* harbor_engine_version(void) {
#if defined(__APPLE__)
  return "0.1.0-macos-juce+coreaudio";
#elif defined(__linux__)
  return "0.1.0-linux-juce+alsa";
#elif defined(_WIN32)
  return "0.1.0-windows-juce+wasapi";
#else
  return "0.1.0";
#endif
}

static void recreatePlayerLocked() {
  if (g_player) {
    g_player->stop();
    g_player.reset();
  }
  g_player.reset(createHarborPlayer());
  if (g_player) {
    g_player->setEventCallback(forwardEvent);
    applyStoredOutputLocked();
  }
}

int harbor_engine_init(HarborEventCallback cb, void* user_data) {
  std::lock_guard lock(g_mutex);
  g_cb = cb;
  g_user = user_data;
  if (!g_player) recreatePlayerLocked();
  return 0;
}

void harbor_engine_shutdown(void) {
  std::lock_guard lock(g_mutex);
  if (g_player) {
    g_player->stop();
    g_player.reset();
  }
  g_cb = nullptr;
  g_user = nullptr;
}

int harbor_engine_list_devices(HarborDevice* out, int max_count) {
  std::lock_guard lock(g_mutex);
  if (!g_player || !out || max_count <= 0) return 0;
  auto devices = g_player->listDevices();
  const int n = std::min(max_count, static_cast<int>(devices.size()));
  for (int i = 0; i < n; ++i) {
    std::memset(&out[i], 0, sizeof(HarborDevice));
    std::snprintf(out[i].uid, sizeof(out[i].uid), "%s", devices[i].uid.c_str());
    std::snprintf(out[i].name, sizeof(out[i].name), "%s", devices[i].name.c_str());
    out[i].is_external = devices[i].isExternal ? 1 : 0;
    out[i].supports_exclusive = devices[i].supportsExclusive ? 1 : 0;
    out[i].supports_dop = devices[i].supportsDop ? 1 : 0;
  }
  return n;
}

int harbor_engine_set_device(const char* uid_or_null) {
  std::lock_guard lock(g_mutex);
  if (uid_or_null) {
    g_deviceUid = uid_or_null;
    g_hasDevice = true;
  } else {
    g_deviceUid.clear();
    g_hasDevice = false;
  }
  if (!g_player) return -1;
  if (g_hasDevice) g_player->setDevice(&g_deviceUid);
  else g_player->setDevice(nullptr);
  return 0;
}

int harbor_engine_set_output_mode(HarborOutputMode mode) {
  std::lock_guard lock(g_mutex);
  g_mode = mode;
  if (!g_player) return -1;
  g_player->setOutputMode(mode);
  return 0;
}

int harbor_engine_set_dsd_pcm_level(int db) {
  std::lock_guard lock(g_mutex);
  g_dsdLevel = db;
  if (!g_player) return -1;
  g_player->setDsdPcmLevel(db);
  return 0;
}

int harbor_engine_load(const char* path) {
  std::lock_guard lock(g_mutex);
  if (!g_player || !path) return -1;
  return g_player->load(path) ? 0 : -1;
}

int harbor_engine_play(void) {
  std::lock_guard lock(g_mutex);
  if (!g_player) return -1;
  g_player->play();
  return 0;
}

int harbor_engine_pause(void) {
  std::lock_guard lock(g_mutex);
  if (!g_player) return -1;
  g_player->pause();
  return 0;
}

int harbor_engine_stop(void) {
  std::lock_guard lock(g_mutex);
  if (!g_player) return -1;
  g_player->stop();
  return 0;
}

int harbor_engine_seek(double seconds) {
  std::lock_guard lock(g_mutex);
  if (!g_player) return -1;
  g_player->seek(seconds);
  return 0;
}

int harbor_engine_set_volume(float level_0_1) {
  std::lock_guard lock(g_mutex);
  if (!g_player) return -1;
  g_player->setVolume(level_0_1);
  return 0;
}

void harbor_engine_get_state(HarborEngineState* out) {
  std::lock_guard lock(g_mutex);
  if (!out) return;
  if (!g_player) {
    std::memset(out, 0, sizeof(*out));
    out->duration_secs = -1;
    out->volume = -1;
    return;
  }
  *out = g_player->getState();
}

void harbor_player_factory_set_requested(HarborAudioBackend backend);

int harbor_engine_set_audio_backend(HarborAudioBackend backend) {
  std::lock_guard lock(g_mutex);
  harbor_player_factory_set_requested(backend);
  recreatePlayerLocked();
  return g_player ? 0 : -1;
}
