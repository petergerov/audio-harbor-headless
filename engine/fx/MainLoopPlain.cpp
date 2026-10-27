// Linux and Windows: the protocol loop is the main thread; editors do not open (yet).
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

} // namespace mainloop

std::unique_ptr<EditorWindow> openEditorWindow(FxPlugin&, const std::string&, std::string& error) {
  error = "Plugin editors open on a Mac host only";
  return nullptr;
}
