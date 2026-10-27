// Windows, and Linux built without X11: the protocol loop is the main thread; no editors.
#include "MainLoop.h"

namespace mainloop {

int run(const std::function<int()>& serve) {
  return serve();
}

void sync(const std::function<void()>& fn) {
  fn();
}

void setIdle(std::function<void()>) {}

bool hasScreen() {
  return false;
}

Handle addTimer(uint32_t, std::function<void()>) {
  return 0;
}

Handle addFd(int, std::function<void()>) {
  return 0;
}

void remove(Handle) {}

} // namespace mainloop

std::unique_ptr<EditorWindow> openEditorWindow(FxPlugin&, const std::string&, std::string& error) {
  error = "This host has no screen to show the editor on";
  return nullptr;
}
