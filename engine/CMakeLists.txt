cmake_minimum_required(VERSION 3.21)
project(harbor_engine VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

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
  src/FrameSource.cpp
  src/PlaybackFeed.cpp
  src/FxClient.cpp
  src/FxStage.cpp
  src/AHDSTDecoder.c
  napi/binding.cpp
)

if(APPLE)
  list(APPEND ENGINE_SOURCES src/MacPlayer.cpp)
elseif(WIN32)
  list(APPEND ENGINE_SOURCES src/WinPlayer.cpp)
elseif(UNIX AND NOT APPLE)
  list(APPEND ENGINE_SOURCES src/LinuxPlayer.cpp)
  find_package(ALSA REQUIRED)
endif()

add_library(${PROJECT_NAME} SHARED ${ENGINE_SOURCES})
set_target_properties(${PROJECT_NAME} PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  OUTPUT_NAME "harbor_engine"
)

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
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

if(MSVC)
  target_compile_definitions(${PROJECT_NAME} PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

if(CMAKE_JS_LIB)
  target_link_libraries(${PROJECT_NAME} PRIVATE ${CMAKE_JS_LIB})
endif()

# --- harbor-fx: the plugin rack's own process (CLAP everywhere, LV2 where lilv is installed) ---
add_executable(harbor-fx fx/main.cpp fx/FxSupport.cpp fx/ClapHost.cpp)
target_include_directories(harbor-fx PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/fx
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party/clap/include
)
# Next to harbor_engine.node, where the engine looks for it.
set_target_properties(harbor-fx PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY $<TARGET_FILE_DIR:${PROJECT_NAME}>
)
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND AND NOT APPLE AND NOT WIN32)
  pkg_check_modules(LILV QUIET IMPORTED_TARGET lilv-0)
endif()
if(LILV_FOUND)
  target_sources(harbor-fx PRIVATE fx/Lv2Host.cpp)
  target_compile_definitions(harbor-fx PRIVATE HARBOR_FX_LV2=1)
  target_link_libraries(harbor-fx PRIVATE PkgConfig::LILV)
  message(STATUS "harbor-fx: LV2 via lilv ${LILV_VERSION}")
else()
  message(STATUS "harbor-fx: CLAP only (lilv-0 not found)")
endif()
# VST3 (MIT SDK, only the hosting parts in third_party/vst3) — macOS and Linux; Windows later.
if(NOT WIN32)
  set(VST3_SDK ${CMAKE_CURRENT_SOURCE_DIR}/third_party/vst3)
  target_sources(harbor-fx PRIVATE
    fx/Vst3Host.cpp
    ${VST3_SDK}/pluginterfaces/base/coreiids.cpp
    ${VST3_SDK}/pluginterfaces/base/funknown.cpp
    ${VST3_SDK}/public.sdk/source/vst/vstinitiids.cpp
    ${VST3_SDK}/public.sdk/source/common/memorystream.cpp
    ${VST3_SDK}/public.sdk/source/common/commonstringconvert.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/hostclasses.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/parameterchanges.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/processdata.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/eventlist.cpp
    ${VST3_SDK}/public.sdk/source/vst/hosting/pluginterfacesupport.cpp
    ${VST3_SDK}/public.sdk/source/vst/utility/stringconvert.cpp
  )
  target_include_directories(harbor-fx PRIVATE ${VST3_SDK})
  # The SDK's own UTF-16 conversion uses std::wstring_convert, deprecated in C++17.
  set_source_files_properties(
    ${VST3_SDK}/public.sdk/source/common/commonstringconvert.cpp
    ${VST3_SDK}/public.sdk/source/vst/utility/stringconvert.cpp
    fx/Vst3Host.cpp
    PROPERTIES COMPILE_OPTIONS "-Wno-deprecated-declarations")
  target_compile_definitions(harbor-fx PRIVATE HARBOR_FX_VST3=1 RELEASE=1)
endif()
if(APPLE)
  target_sources(harbor-fx PRIVATE fx/AuHost.cpp)
  target_link_libraries(harbor-fx PRIVATE "-framework CoreFoundation" "-framework AudioToolbox" "-framework CoreAudio")
elseif(UNIX)
  target_link_libraries(harbor-fx PRIVATE Threads::Threads dl)
endif()
if(MSVC)
  target_compile_definitions(harbor-fx PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

# A gain plugin for tests (not shipped): `harbor-test-gain.clap`, -6.02 dB by default.
add_library(harbor-test-gain MODULE fx/test/TestGain.cpp)
target_include_directories(harbor-test-gain PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/clap/include)
set_target_properties(harbor-test-gain PROPERTIES
  PREFIX ""
  SUFFIX ".clap"
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/test-plugins
)

# FxStage against harbor-fx and the test plugins (not shipped): build/fx-stage-test
add_executable(fx-stage-test fx/test/StageTest.cpp src/FxClient.cpp src/FxStage.cpp)
target_include_directories(fx-stage-test PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
  ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)
set_target_properties(fx-stage-test PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR})
if(UNIX AND NOT APPLE)
  target_link_libraries(fx-stage-test PRIVATE Threads::Threads dl)
endif()
