cmake_minimum_required(VERSION 3.21)
project(harbor_engine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# JUCE is always built in (shared shipping stack). Mac/Linux also compile native
# players so users can choose at runtime: output.backend = juce | native | auto
option(HARBOR_WITH_JUCE "Build JUCE audio backend" ON)

add_definitions(-DNAPI_VERSION=8)

# --- Node / N-API ---
if(NOT DEFINED CMAKE_JS_INC)
  execute_process(
    COMMAND node -p "require('node-addon-api').include"
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    OUTPUT_VARIABLE NAPI_INCLUDE_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
  )
  string(REPLACE "\"" "" NAPI_INCLUDE_DIR "${NAPI_INCLUDE_DIR}")
  execute_process(
    COMMAND node -p "process.execPath"
    OUTPUT_VARIABLE NODE_EXEC
    OUTPUT_STRIP_TRAILING_WHITESPACE
  )
  get_filename_component(NODE_BIN_DIR "${NODE_EXEC}" DIRECTORY)
  get_filename_component(NODE_ROOT "${NODE_BIN_DIR}" DIRECTORY)
  set(CMAKE_JS_INC "${NODE_ROOT}/include/node")
  if(NOT EXISTS "${CMAKE_JS_INC}/node.h")
    execute_process(
      COMMAND node -p "require('path').dirname(process.execPath)+'/../include/node'"
      OUTPUT_VARIABLE CMAKE_JS_INC
      OUTPUT_STRIP_TRAILING_WHITESPACE
    )
  endif()
endif()

include_directories(${CMAKE_JS_INC})
if(DEFINED NAPI_INCLUDE_DIR)
  include_directories(${NAPI_INCLUDE_DIR})
endif()

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-addon-api")
  include_directories("${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-addon-api")
elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/../node_modules/node-addon-api")
  include_directories("${CMAKE_CURRENT_SOURCE_DIR}/../node_modules/node-addon-api")
endif()

set(ENGINE_SOURCES
  src/HarborEngine.cpp
  src/PlayerFactory.cpp
  src/StubPlayer.cpp
  src/DsdPipeline.cpp
  src/PcmDecoder.cpp
  src/AHDSTDecoder.c
  napi/binding.cpp
)

# Native backends always available (runtime selectable alongside JUCE)
if(APPLE)
  list(APPEND ENGINE_SOURCES src/MacPlayer.cpp)
elseif(WIN32)
  list(APPEND ENGINE_SOURCES src/WinPlayer.cpp)
elseif(UNIX AND NOT APPLE)
  list(APPEND ENGINE_SOURCES src/LinuxPlayer.cpp)
  find_package(ALSA REQUIRED)
endif()

if(HARBOR_WITH_JUCE)
  include(FetchContent)
  FetchContent_Declare(
    juce
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG        8.0.4
    GIT_SHALLOW    TRUE
  )
  FetchContent_MakeAvailable(juce)
  list(APPEND ENGINE_SOURCES src/JucePlayer.cpp)
  add_compile_definitions(HARBOR_WITH_JUCE=1)
endif()

add_library(${PROJECT_NAME} SHARED ${ENGINE_SOURCES})
set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  OUTPUT_NAME "harbor_engine"
)

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${CMAKE_JS_INC}
)

if(APPLE)
  target_link_libraries(${PROJECT_NAME} PRIVATE
    "-framework CoreAudio"
    "-framework AudioToolbox"
    "-framework AudioUnit"
    "-framework CoreFoundation"
    "-framework Cocoa"
    "-framework Accelerate"
    "-framework IOKit"
  )
elseif(WIN32)
  target_link_libraries(${PROJECT_NAME} PRIVATE ole32 uuid avrt)
elseif(UNIX AND NOT APPLE)
  find_package(Threads REQUIRED)
  target_link_libraries(${PROJECT_NAME} PRIVATE ALSA::ALSA Threads::Threads dl)
endif()

if(HARBOR_WITH_JUCE)
  target_link_libraries(${PROJECT_NAME} PRIVATE
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_utils
    juce::juce_core
    juce::juce_events
  )
  target_compile_definitions(${PROJECT_NAME} PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_MODAL_LOOPS_PERMISSION=0
  )
endif()

if(MSVC)
  target_compile_definitions(${PROJECT_NAME} PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

if(CMAKE_JS_LIB)
  target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB})
endif()
