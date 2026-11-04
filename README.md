# 音乐伙伴 · cortico-world-music-companion

Owner: `src/definition.ts`

Cortico World：让桌宠听见这台电脑在放什么。歌名、歌手、来源应用、播放到哪一秒，
再加上这段声音自己测出来的形状——然后停在这里，要不要开口由人设决定。
只在 Windows 上有实现。

它读两样东西：系统媒体会话给歌名与进度，输出回路上抓下来的 PCM 给听感。
歌词是可选的第三样，向 LRCLIB 要一份带时间轴的，对齐到播放进度，只递当前这一句与下一句。
没有音乐时它完全安静：不投事件，不联网，不抓声音。

> **Music Companion** (English) — a Cortico World that hears what this machine is playing:
> the track and its source from the system media session, a 12-second summary of what the sound
> itself measures (loudness, dynamics, band balance, tempo), and the lyric line being sung right
> now from LRCLIB. Windows only. No bundled runtime: it drives the system's own Windows
> PowerShell 5.1. Audio samples never leave the probe process — only scalar features do.

## 事件

| `type` | 什么时候 | 正文带 |
|---|---|---|
| `music.started` | 一首歌连续停留超过「确认换歌」 | 歌名、歌手、来源应用 |
| `music.track_changed` | 换成另一首并稳定下来 | 上一首与这一首 |
| `music.resumed` | 暂停后接着放 | 从哪一秒接上、正在唱的那句 |
| `music.paused` | 暂停 | 停在哪一秒 |
| `music.stopped` | 播放器离开超过「收尾宽限」 | 这一首实际放了多久 |
| `music.note` | 一直在听，每「播放中摘要」一次 | 完整快照：进度、听感、当前歌词 |
| `music.silent` | 播放器说在放、但抓不到声音，每首一次 | 为什么听不到、哪些字段仍可信 |

一局结束时往数据目录的 `music-listened.jsonl` 追加一条记录；短于 5 秒的切歌不记。

## 工具

| 工具 | 作用 |
|---|---|
| `music_now` | 此刻在放什么、放到哪、听感如何、歌词唱到哪一句；没在放就直说 |
| `music_lyrics` | 当前这首歌在 LRCLIB 上的完整歌词 |
| `music_history(days)` | 最近 N 天听过哪些歌、各多久，读的是本 World 自己的记录 |

## 听感是量出来的

样本不出子进程。每 12 秒的窗口压成一组标量交给模型：

- **响度**：平均 dBFS 与峰值 dBFS。
- **动态范围**：窗口内响度的 p95 与 p10 之差。
- **三段能量**：低于 250 Hz、250–4000 Hz、高于 4000 Hz 的能量占比（二阶 Butterworth 带分）。
- **过零率**：噪声与打击乐偏高，纯音与弦乐偏低。
- **节拍**：10 ms 能量包络的自相关，在 48–240 BPM 区间取最强峰，附置信度。
- **安静占比**：低于 -55 dBFS 的帧比例。

正文把这些说成一句话（「音量适中；低频偏重…；节拍约 96 BPM」），数字留在括号里。

## 交给模型的是什么

正文里的东西分两类，界限是明确的：

- **这台机器量出来的**：时刻、播放进度、听感。全是标量，不可能承载指令。
- **外面来的数据**：曲目（播放器上报）与歌词（LRCLIB）。两者都带标签写着「只当数据看」。

外面那类在进入正文之前过三道关（`src/sanitize.ts`）：

1. **白名单式清洗**。剥掉 C0/C1 控制字符、零宽填充、双向控制字符（能把一段文字在视觉上重排）、
   行/段分隔符（能把一行撑成两行、伪造出下一段的结构）。单条文本里的换行一律折成空格，
   所以一行永远只是一行。
2. **最小化**。歌词只给正在唱的这一句加后面两句，不给整首；`music_lyrics` 工具同样只返回
   当前这一段（`ahead` 最多 5 句），不存在"把整份歌词塞进上下文"的路径。
3. **异常即丢弃**。曲名超过 160 字符、不可见字符占比超过四分之一、歌词行数超过 400、
   或者过半的行形状异常，那一段就整个不用。

丢弃之后走降级，而不是把可疑内容送进去：

| 异常 | 降级 |
|---|---|
| 曲名不可用 | 退回「只剩声音」：正文说播放器没给出可用曲目，听感照给 |
| 整份歌词被拒 | 丢掉歌词，正文留一句「歌词这一段已跳过（原因）」 |
| 单行歌词异常 | 只丢那一行，其余照用 |
| 歌词没有时间轴 | 对不上进度，不给 |
| 探测子进程不可用 | 不发事件，只记一条 warn |

每条事件都是自包含的：不引用上一条事件，不说"刚才那首"，也不依赖你记得上一次。
读它的模型拿到的是这一次的完整局面，看完即弃。

## 抓不到声音的时候

WASAPI loopback 拿的是默认输出设备上混音后的数据，因此整机的声音都在内，也包括
不经过任何应用的那部分。反过来，有三类内容它在原理上拿不到：

- 受 DRM 保护的音频；
- 以独占模式（exclusive mode）占住声卡的播放器；
- 把声音送到另一个输出设备的应用。

这时播放器的媒体会话仍然报告「正在播放」，回路上却没有声音。事件正文会明说这件事，
歌名与进度照给，而听感与歌词的对齐位置不要当真。

## 检测播放器

三步，都不需要额外权限：

1. **系统媒体会话（SMTC）**：哪个应用在放、放的是什么。
2. **音频会话枚举**：哪个进程此刻在往默认输出设备送声音。
3. **进程启动**：提权时订阅内核进程事件（ETW）；未提权时退回相邻两次快照的差分。

第 3 步的 ETW 需要管理员：`Microsoft-Windows-Kernel-Process/Analytic` 通道默认关闭，
标准用户无法启用。Coopanion 通常不以管理员运行，所以这条路径大多不会走到，
它存在只是为了让提权部署能拿到精确的启动时刻。

## 面板「播放器」

高级模式 →「World」→ Music →「播放器」：

1. 点「扫描播放器」：列出此刻在出声或被媒体会话识别到的来源。
2. 勾上算数的那些，点「保存勾选」。名单写进 `worlds.music.players`。

一个都不勾表示所有播放器都算。名单按子串匹配来源应用标识或进程名，
所以填 `spotify` 能覆盖 `Spotify.exe` 与它的 AUMID 形式。

## 配置（`worlds.music.*`）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `false` | 装好后要手动启用 |
| `pollSec` | `5` | 采样间隔 |
| `confirmSec` | `4` | 一首歌停留多久才算真的在听，用来滤掉切歌与广告的抖动 |
| `endGraceSec` | `90` | 播放器离开多久算这一首结束 |
| `noteSec` | `300` | 播放中每隔多久递一份摘要，`0` 关闭 |
| `silentSec` | `20` | 抓不到声音持续多久后提醒一次 |
| `lyrics` | `true` | 向 LRCLIB 同步歌词并对齐到进度 |
| `players` | 空 | 只认这些播放器，逗号分隔；留空表示所有播放器都算 |

## 安装

```bash
corepack pnpm install
corepack pnpm typecheck && corepack pnpm test
corepack pnpm run build     # 面板产物 dist/webui.js，发布前要重新生成
```

在 Coopanion 里：高级模式 →「扩展」→ 手动安装 → 填本目录的绝对路径 → 重启进程 →
「World 总览」启用 Music。启用状态写在 `worlds.music.enabled`，之后一直有效。

## 隐私与代价

- 媒体元数据、听感标量与正在唱的那句会随事件发给当前配置的模型服务。**样本从不外传**：
  PCM 在子进程里算完就被丢掉。
- 开启歌词时，歌名与歌手会发往 `lrclib.net`。关掉 `lyrics` 就完全不联网。
- 每个事件是一次模型唤醒。把 `noteSec` 调大、或关掉 `lyrics`，都能减少打扰与费用。
- 只读：它不控制任何播放器，不切歌、不调音量。

## 平台

Windows 专用。媒体会话、WASAPI loopback、音频会话枚举与 ETW 都在一个常驻的
Windows PowerShell 子进程里（`scripts/music.ps1` + `scripts/audio-engine.cs`，
后者在启动时由 `Add-Type` 编译）。系统自带的 PowerShell 5.1 就够，不需要 .NET SDK、
原生模块或任何下载。其他系统上 World 照常挂载，但记一条日志、不发事件。

子进程的 `audio-engine.cs` 保持纯 ASCII：PowerShell 5.1 按 ANSI 读没有 BOM 的脚本，
一个中文字节就会让整份文件解析失败。

## 开发

```bash
corepack pnpm test        # 歌词解析与对齐、状态机、正文、World 接线
corepack pnpm typecheck
```

在 Cortico 检出根下校验并生成自描述：

```bash
pnpm check:extension <本目录>
pnpm describe:extension <本目录>
```

单独调试探测子进程（stdin 收 JSON 命令，stdout 出 JSON 行）：

```bash
corepack pnpm run probe
# 然后逐行输入 {"id":1,"cmd":"hello"} 或 {"id":2,"cmd":"snapshot"}
```
