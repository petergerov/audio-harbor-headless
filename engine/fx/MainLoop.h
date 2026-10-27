#pragma once

#include "FxPlugin.h"

#include <functional>
#include <memory>
#include <string>

/**
 * The thread the plugins see as their main thread. With a screen — a Mac with someone logged
 * in, a Linux desktop (X11) — it is the process's real main thread running an event loop (Cocoa;
 * on Linux poll() over timers, the plugins' file descriptors and X11), so plugin editors can open
 * in windows; the protocol is read on another thread and each message handed over. Without one
 * (a Pi as a service, Windows) the protocol loop is the main thread, as before.
 */
namespace mainloop {

using Handle = uint64_t;

/** Runs `serve` (which reads the protocol and hands each message to sync()) and returns its result. */
int run(const std::function<int()>& serve);

/** Runs fn on the main thread and waits for it. */
void sync(const std::function<void()>& fn);

/** Called on the main thread ~30 times a second while the run loop turns (the protocol loop
 *  also idles after each message): callbacks plugins asked for, windows closed on the screen. */
void setIdle(std::function<void()> fn);

/** Editors can open: a Mac with a logged-in screen, a Linux desktop. */
bool hasScreen();

/**
 * Linux editors (CLAP timer-support, VST3 IRunLoop, LV2 UI idle): `fn` every `ms` on the main
 * thread. Elsewhere editors keep their own timers: these do nothing and return 0.
 */
Handle addTimer(uint32_t ms, std::function<void()> fn);
/** Linux editors: `fn` on the main thread whenever `fd` is readable (or has an error). */
Handle addFd(int fd, std::function<void()> fn);
void remove(Handle handle);

} // namespace mainloop

/** A plugin's editor in a window of its own on the host's screen. Closing it closes the editor. */
class EditorWindow {
public:
  virtual ~EditorWindow() = default;
  /** The window was closed on the screen; the owner drops it at the next idle. */
  virtual bool closedOnScreen() const = 0;
  /** The window's number for the window server (tests find it by this). */
  virtual long number() const = 0;
};

/** Opens `plugin`'s editor in a window titled `title`, brought to the front. */
std::unique_ptr<EditorWindow> openEditorWindow(FxPlugin& plugin, const std::string& title, std::string& error);
