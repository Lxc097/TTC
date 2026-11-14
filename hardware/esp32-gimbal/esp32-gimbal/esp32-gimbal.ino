#include <Arduino.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_arduino_version.h>

#include "control_page.h"

#if __has_include("wifi_local.h")
#include "wifi_local.h"
#endif

#ifndef GIMBAL_AP_PASSWORD
#define GIMBAL_AP_PASSWORD "Gimbal-7628"
#endif

#if ESP_ARDUINO_VERSION_MAJOR < 3
#error Install Arduino-ESP32 3.x from Espressif Systems.
#endif

#if !CONFIG_IDF_TARGET_ESP32S3
#error Select ESP32S3 Dev Module for this sketch.
#endif

constexpr uint8_t PAN_PIN = 4;
constexpr uint8_t TILT_PIN = 5;

constexpr char AP_NAME[] = "Lx097";
constexpr char AP_PASSWORD[] = GIMBAL_AP_PASSWORD;
static_assert(sizeof(AP_PASSWORD) >= 9 && sizeof(AP_PASSWORD) <= 64,
              "Use an 8 to 63 character Wi-Fi password");
constexpr uint32_t PWM_HZ = 50;
constexpr uint8_t PWM_BITS = 14;
constexpr uint32_t FRAME_US = 1'000'000 / PWM_HZ;
constexpr uint32_t UPDATE_MS = FRAME_US / 1000;
constexpr int STEP_US = 6;

struct ServoCalibration {
  uint8_t pin;
  int minUs;
  int centerUs;
  int maxUs;
  bool reverse;
};

// Commission the unloaded mechanism at these limits before adjusting them.
constexpr ServoCalibration PAN = {PAN_PIN, 1350, 1500, 1650, false};
constexpr ServoCalibration TILT = {TILT_PIN, 1350, 1500, 1650, false};

constexpr bool validCalibration(const ServoCalibration& axis) {
  return axis.minUs >= 500 && axis.minUs < axis.centerUs &&
         axis.centerUs < axis.maxUs && axis.maxUs <= 2500;
}

static_assert(PAN.pin != TILT.pin, "Use distinct servo output GPIOs");
static_assert(validCalibration(PAN) && validCalibration(TILT), "Check servo pulse calibration");

WebServer server(80);
bool available = false;
bool enabled = false;
int panTarget = 0;
int tiltTarget = 0;
int panUs = PAN.centerUs;
int tiltUs = TILT.centerUs;
uint32_t lastUpdate = 0;

static bool writePulse(uint8_t pin, int pulseUs) {
  const uint32_t duty = (pulseUs * (1UL << PWM_BITS) + FRAME_US / 2) / FRAME_US;
  return ledcWrite(pin, duty);
}

static void stopOutput() {
  const bool panStopped = writePulse(PAN.pin, 0);
  const bool tiltStopped = writePulse(TILT.pin, 0);
  if (!panStopped || !tiltStopped) {
    ledcDetach(PAN.pin);
    ledcDetach(TILT.pin);
    pinMode(PAN.pin, OUTPUT);
    pinMode(TILT.pin, OUTPUT);
    digitalWrite(PAN.pin, LOW);
    digitalWrite(TILT.pin, LOW);
    available = false;
  }
  enabled = false;
  panTarget = 0;
  tiltTarget = 0;
}

static int targetPulse(const ServoCalibration& axis, int target) {
  if (axis.reverse) target = -target;
  const int span = target < 0 ? axis.centerUs - axis.minUs : axis.maxUs - axis.centerUs;
  return axis.centerUs + target * span / 100;
}

static void updateServos() {
  const uint32_t now = millis();
  if (!enabled || now - lastUpdate < UPDATE_MS) return;
  lastUpdate = now;

  const int nextPan = panUs + constrain(targetPulse(PAN, panTarget) - panUs, -STEP_US, STEP_US);
  const int nextTilt = tiltUs + constrain(targetPulse(TILT, tiltTarget) - tiltUs, -STEP_US, STEP_US);
  if ((nextPan != panUs && !writePulse(PAN.pin, nextPan)) ||
      (nextTilt != tiltUs && !writePulse(TILT.pin, nextTilt))) {
    stopOutput();
    available = false;
    Serial.println("Servo PWM write failed; outputs disabled");
    return;
  }
  panUs = nextPan;
  tiltUs = nextTilt;
}

static void sendState() {
  char body[96];
  snprintf(body, sizeof(body), "{\"available\":%s,\"enabled\":%s,\"pan\":%d,\"tilt\":%d}",
           available ? "true" : "false", enabled ? "true" : "false", panTarget, tiltTarget);
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", body);
}

static void sendError(int status, const char* body) {
  server.sendHeader("Cache-Control", "no-store");
  server.send(status, "application/json; charset=utf-8", body);
}

static bool acceptCommand() {
  if (server.header("X-Gimbal-Control") != "1") {
    sendError(403, R"({"error":"请从云台控制页面操作"})");
    return false;
  }
  return true;
}

static bool canMove() {
  if (!acceptCommand()) return false;
  if (!available || !enabled) {
    sendError(409, R"({"error":"请先启用舵机输出"})");
    return false;
  }
  return true;
}

static bool parsePosition(const String& input, int& result) {
  size_t i = 0;
  const bool negative = input.length() > 0 && input[0] == '-';
  if (negative) ++i;
  const size_t digits = input.length() - i;
  if (digits == 0 || digits > 3) return false;
  int value = 0;
  for (; i < input.length(); ++i) {
    if (input[i] < '0' || input[i] > '9') return false;
    value = 10 * value + input[i] - '0';
  }
  if (value > 100) return false;
  result = negative ? -value : value;
  return true;
}

static void handlePosition() {
  if (!canMove()) return;
  int newPan, newTilt;
  if (!parsePosition(server.arg("pan"), newPan) || !parsePosition(server.arg("tilt"), newTilt)) {
    sendError(400, R"({"error":"两个轴的目标都必须是 −100 到 100 的整数"})");
    return;
  }
  panTarget = newPan;
  tiltTarget = newTilt;
  sendState();
}

static void handleEnable() {
  if (!acceptCommand()) return;
  if (!available) {
    sendError(503, R"({"error":"PWM 输出不可用，请检查板型及引脚设置"})");
    return;
  }
  if (!enabled) {
    panUs = PAN.centerUs;
    tiltUs = TILT.centerUs;
    if (!writePulse(PAN.pin, panUs) || !writePulse(TILT.pin, tiltUs)) {
      stopOutput();
      available = false;
      sendError(503, R"({"error":"启动 PWM 失败"})");
      return;
    }
    enabled = true;
    lastUpdate = millis();
  }
  sendState();
}

void setup() {
  Serial.begin(115200);
  const bool panReady = ledcAttach(PAN.pin, PWM_HZ, PWM_BITS);
  const bool tiltReady = ledcAttach(TILT.pin, PWM_HZ, PWM_BITS);
  available = panReady && tiltReady;
  stopOutput();
  Serial.printf("Servo PWM: %s (pan GPIO%u, tilt GPIO%u)\n",
                available ? "ready, disabled" : "initialization failed", PAN.pin, TILT.pin);

  const IPAddress apIP(192, 168, 4, 1);
  const IPAddress netmask(255, 255, 255, 0);
  if (!WiFi.mode(WIFI_AP) || !WiFi.softAPConfig(apIP, apIP, netmask) ||
      !WiFi.softAP(AP_NAME, AP_PASSWORD, 1, false, 1)) {
    Serial.println("Wi-Fi access point start failed");
    return;
  }
  const char* headers[] = {"X-Gimbal-Control"};
  server.collectHeaders(headers, 1);
  server.on("/", HTTP_GET, [] {
    server.sendHeader("Cache-Control", "no-store");
    server.send_P(200, "text/html; charset=utf-8", CONTROL_PAGE);
  });
  server.on("/api/state", HTTP_GET, sendState);
  server.on("/api/enable", HTTP_POST, handleEnable);
  server.on("/api/disable", HTTP_POST, [] {
    if (!acceptCommand()) return;
    if (enabled) stopOutput();
    sendState();
  });
  server.on("/api/center", HTTP_POST, [] {
    if (!canMove()) return;
    panTarget = 0;
    tiltTarget = 0;
    sendState();
  });
  server.on("/api/position", HTTP_POST, handlePosition);
  server.begin();
  Serial.print("Control page: http://");
  Serial.println(WiFi.softAPIP());
}

void loop() {
  server.handleClient();
  updateServos();
  delay(1);
}
