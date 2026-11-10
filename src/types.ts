/**
 * 探测子进程与 World 之间共用的形状。这里只有事实：抓到了什么、播放器说是什么、
 * 这段声音算出来的数。是不是"在听歌"、要不要开口，都不在这里判断。
 */

/** 最近 12 秒的听感摘要。样本本身不出子进程，这里只有标量。 */
export interface AudioFeatures {
  /** loopback 客户端当前是否活着。 */
  ok: boolean;
  error?: string;
  running: boolean;
  sampleRate: number;
  channels: number;
  bits: number;
  /** 自启动以来读到的音频包数。0 表示这条链路上还没有任何声音经过。 */
  packets: number;
  frames: number;
  /** 距上一个音频包多少毫秒；-1 表示从未收到过。 */
  staleMs: number;
  /** 窗口里实际有数据的时长，最多 12000。 */
  windowMs: number;
  /** 窗口内低于 -55 dBFS 的帧占比，0…1。 */
  silentRatio: number;
  rmsDb: number;
  peakDb: number;
  /** 响度的 p95 与 p10 之差，单位 dB。流行乐常见 6–15。 */
  dynamicDb: number;
  /** 低（<250 Hz）/ 中（250–4000 Hz）/ 高（>4000 Hz）能量占比，三者相加为 1。 */
  band: { low: number; mid: number; high: number };
  /** 过零率，0…1。噪声与打击乐高，纯人声与弦乐低。 */
  zcr: number;
  /** 自相关估出的 BPM；信号不足以估计时为 0。 */
  bpm: number;
  /** 节拍置信度，0…1。低于 0.3 的 bpm 不要当真。 */
  bpmStrength: number;
}

/** 一个系统媒体会话（SMTC）。status 是 Windows 的原文：Playing / Paused / Stopped / Closed 等。 */
export interface MediaSession {
  /** 来源应用，通常是 AUMID，例如 `Spotify.exe`。 */
  app: string;
  title: string;
  artist: string;
  album: string;
  status: string;
  positionSec: number;
  durationSec: number;
  /** 播放进度最后一次更新的时刻（epoch 毫秒）；0 表示应用没给。 */
  lastUpdatedMs: number;
}

/** 一个音频会话：某个进程此刻在往默认输出设备送声音。 */
export interface AudioSessionRow {
  process: string;
  pid: number;
  state: 'active' | 'inactive' | 'expired' | 'unknown';
}

/** 一次探测的全部结果。 */
export interface ProbeSnapshot {
  at: number;
  audio: AudioFeatures;
  sessions: AudioSessionRow[];
  /** 自上次快照以来新出现的进程，由进程名单差分得出；ticks 目前恒为 0。 */
  starts: Array<{ name: string; ticks: number }>;
  media: MediaSession[];
}

/** 子进程启动时报告的能力。缺哪一样，对应的降级路径就要说清楚。 */
export interface ProbeCapabilities {
  admin: boolean;
  smtc: boolean;
  loopbackError: string;
  /** 进程启动是怎么得来的；目前恒为快照差分。 */
  startsNote: string;
  powershell: string;
}

/** 一首歌的身份。key 用来判断"还是不是同一首"。 */
export interface TrackIdentity {
  key: string;
  title: string;
  artist: string;
  album: string;
  /** 放这首歌的应用，例如 `spotify.exe`。 */
  app: string;
  durationSec: number;
}

/** 一行歌词。atMs 是这一行开始的时间；没有时间轴的歌词整首只给一份纯文本。 */
export interface LyricLine {
  atMs: number;
  text: string;
}

/** 对齐到当前进度的歌词视图。 */
export interface LyricsView {
  /** 这一行正在唱。 */
  current: string;
  /** 上一行，用来接话。 */
  previous: string;
  /** 下一行会唱什么。 */
  upcoming: string;
  /** 下一行在多少秒后开始；不知道就是 null。 */
  upcomingInSec: number | null;
  /** 整首歌还有几行没唱，用来判断是不是快结束了。 */
  linesRemaining: number;
  /** 这份歌词是有时间轴的还是纯文本。 */
  timed: boolean;
}

/** 一次歌曲会话的快照，交给状态机与正文渲染。 */
export interface NowPlaying {
  at: number;
  track: TrackIdentity;
  /** 播放器报告的状态，已归一化。 */
  state: 'playing' | 'paused' | 'stopped';
  /** 外推后的播放进度（秒）。 */
  positionSec: number;
  /** 音频侧的事实。 */
  audio: AudioFeatures;
  /** 发送方在问这一首是不是受保护内容：SMTC 说在放，但系统里没有声音经过。 */
  silentButPlaying: boolean;
  /** 这一首开始播放到现在多久。 */
  elapsedMs: number;
}
