# ESP32 双轴云台

适用于照片中的 ESP32-S3-N16R8 开发板与两颗 S620A 180° 三线 PWM 位置舵机。ESP32 建立 Wi‑Fi 热点，手机浏览器可以调节水平、俯仰和回中。控制页显示相对于校准区间的目标百分比。180° 是舵机规格，云台能走多远由实际安装和机械限位决定。

## 接线

断开舵机电源后接线。用 USB 给 ESP32 供电，两个舵机的电源正极并联到独立稳压电源，电源负极、两个舵机的地和 ESP32 的 `GND` 连在一起。舵机电源正极只接舵机。按舵机标签或销售方的实际规格确认供电电压、插头线序和 PWM 输入电平。电源的持续输出能力应大于两颗舵机堵转电流之和。

如果卖家确认这批舵机支持 `5 V` 且单颗在 `5 V` 的堵转电流约为 `1.8 A`，可用 `5 V / 5 A` 稳压电源给两颗供电。舵机供电用能承受该电流的线材和端子从电源直接分配。面包板可用来引出信号和 ESP32 共地线。

| 线路 | 接到 |
| --- | --- |
| 水平舵机信号 | ESP32-S3 `GPIO4` |
| 俯仰舵机信号 | ESP32-S3 `GPIO5` |
| 两个舵机的电源正极 | 独立电源正极 |
| 两个舵机的地 | 独立电源负极和 ESP32 的 `GND` |

表中是 GPIO 编号。看照片中的板子正面，USB 口在上方时，右排下方标有 `4`、`5`，紧挨 `RST`。需要改脚时，编辑草图顶部的 `PAN_PIN`、`TILT_PIN`。ESP32 输出 3.3 V PWM 信号。如果确认该批舵机需要更高的信号电平，请用兼容 3.3 V 输入的单向电平转换器，并保持共地。

## 烧录与手机连接

1. 在 Arduino IDE 安装 Espressif Systems 的 `esp32` 开发板包 3.x。依赖随开发板包提供。可在 IDE 的「其他开发板管理器地址」添加官方[稳定版索引](https://espressif.github.io/arduino-esp32/package_esp32_index.json)，再通过开发板管理器安装。[Espressif 安装说明](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html)
2. 打开 `esp32-gimbal/esp32-gimbal.ino`。选择 `ESP32S3 Dev Module`，将 `Flash Size` 设为 `16MB (128Mb)`、`PSRAM` 设为 `OPI PSRAM`、`Partition Scheme` 设为 `16M Flash (2MB APP/12.5MB FATFS)`。USB 线接背面丝印 `USB` 的接口时，选择 `Hardware CDC and JTAG`、`USB CDC On Boot: Enabled` 和 `Upload Mode: UART0 / Hardware CDC`，再选择 Windows 识别出的串口上传。若需读日志，串口监视器设 `115200`。[Espressif 的 N16R8 和 USB 设置](https://docs.espressif.com/projects/arduino-esp32/en/latest/troubleshooting.html) · [USB CDC 烧录说明](https://docs.espressif.com/projects/arduino-esp32/en/latest/tutorials/cdc_dfu_flash.html)
3. 手机连 `Lxc097`，输入烧录时设置的密码。直接烧录仓库里的示例，密码为 `Gimbal-7628`。手机提示 Wi‑Fi 无互联网时，选择保持连接。用 Safari 或 Chrome 打开 [云台控制页](http://192.168.4.1/)。热点同时允许一台设备连接。遇到同名热点时，可临时关闭那个热点再连接。云台热点在手机 Wi‑Fi 详情里显示的路由器地址是 `192.168.4.1`。

要设置自己的密码，复制草图目录到本地独立位置，在副本中创建 `wifi_local.h`，写入 `#define GIMBAL_AP_PASSWORD "你的密码"`。将引号内替换成 8–63 个 ASCII 字符，再上传这个副本。需要更改热点名时，修改 `AP_NAME`。

如果上传时卡在 `Connecting`，按住板上的 `BOOT`，点按一下 `RST`，再松开 `BOOT`。在 Windows 或 Arduino IDE 里确认下载模式下的串口号后重试。首次上传完成后如果热点未出现，点按一次 `RST` 正常启动。

## 首次试动与校准

1. 取下相机等负载。首次通电试动时，先解开舵盘或连杆，让两个舵机能空载转动。连接手机后，点「启用舵机」，固件发送约 `1500 µs` 中位脉冲。确认两轴回到中位后，支撑云台、断开舵机电源，再把舵盘或连杆装在机构中位。
2. 重新上电，从零点小幅移动两个滑杆，先分别验证方向和限位。每个轴的默认脉宽范围为 `1350–1650 µs`，频率 `50 Hz`。根据空载实测逐步调 `PAN` 和 `TILT` 的 `minUs`、`centerUs`、`maxUs`。滑杆方向需要反转时，将该轴的 `reverse` 改为 `true`。两个轴都给支架、线材和负载留出余量。
3. ESP32 启动时默认关闭两个 PWM 输出。手机断开或重连时，舵机继续走到最后收到的目标并保持。点「关闭输出」或切断舵机电源前先支撑负载，俯仰轴可能下垂。再次点击「启用舵机」会直接发送中位脉冲，启动动作的速度由舵机决定。

[舵机 PWM 接口说明](https://www.pololu.com/blog/17/servo-control-interface-in-detail) · [Espressif LEDC 接口文档](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/ledc.html)
