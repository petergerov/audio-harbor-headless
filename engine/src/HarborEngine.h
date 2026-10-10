#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum HarborOutputMode {
  HARBOR_MODE_SHARED = 0,
  HARBOR_MODE_EXCLUSIVE = 1,
  HARBOR_MODE_DOP = 2
} HarborOutputMode;

/** Audio I/O stack. auto resolves to the platform native player. */
typedef enum HarborAudioBackend {
  HARBOR_BACKEND_AUTO = 0,   /* → native */
  HARBOR_BACKEND_NATIVE = 1  /* Core Audio / ALSA / WASAPI */
} HarborAudioBackend;

typedef enum HarborPlaybackState {
  HARBOR_STATE_IDLE = 0,
  HARBOR_STATE_LOADING = 1,
  HARBOR_STATE_PLAYING = 2,
  HARBOR_STATE_PAUSED = 3,
  HARBOR_STATE_FAILED = 4
} HarborPlaybackState;

typedef struct HarborDevice {
  char uid[128];
  char name[256];
  int is_external;
  int supports_exclusive;
  int supports_dop;
} HarborDevice;

typedef struct HarborEngineState {
  HarborPlaybackState state;
  double position_secs;
  double duration_secs; /* < 0 if unknown */
  HarborOutputMode effective_mode;
  char conversion_badge[128];
  float volume; /* < 0 if unavailable */
  char error[256];
} HarborEngineState;

typedef void (*HarborEventCallback)(const char* event, const char* json_payload, void* user_data);

const char* harbor_engine_version(void);

int harbor_engine_init(HarborEventCallback cb, void* user_data);
void harbor_engine_shutdown(void);

int harbor_engine_list_devices(HarborDevice* out, int max_count);
int harbor_engine_set_device(const char* uid_or_null);
int harbor_engine_set_output_mode(HarborOutputMode mode);
int harbor_engine_set_dsd_pcm_level(int db /* 0, 3, 6 */);

/** Switch audio backend (recreates the player). Returns 0 on success. */
int harbor_engine_set_audio_backend(HarborAudioBackend backend);
HarborAudioBackend harbor_engine_get_audio_backend(void);
HarborAudioBackend harbor_engine_get_requested_audio_backend(void);
/** Writes comma-separated names into out, e.g. "auto,native". */
int harbor_engine_list_audio_backends(char* out, size_t out_len);
const char* harbor_engine_audio_backend_name(HarborAudioBackend backend);

int harbor_engine_load(const char* path);
int harbor_engine_play(void);
int harbor_engine_pause(void);
int harbor_engine_stop(void);
int harbor_engine_seek(double seconds);
int harbor_engine_set_volume(float level_0_1);

void harbor_engine_get_state(HarborEngineState* out);

#ifdef __cplusplus
}
#endif
