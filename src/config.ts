import type { ConfigGroup } from 'cortico/core/types.ts';

/**
 * config.json 的 worlds.music 段。键扁平，WebUI 的配置接口写不了列表和对象；
 * 播放器名单是一段逗号分隔的文本。
 */
export interface MusicConfigSection {
  enabled: boolean;
  /** 采样间隔。 */
  pollSec: number;
  /** 一首歌连续待够这么久才算在听，用来滤掉切歌、广告与拖动进度条的抖动。 */
  confirmSec: number;
  /** 播放器消失或停住多久算这一首结束。 */
  endGraceSec: number;
  /** 播放中每隔多久递一次摘要；0 关闭。 */
  noteSec: number;
  /** 播放器说在放、但抓不到声音多久之后报一次。 */
  silentSec: number;
  /** 从 LRCLIB 同步歌词并对齐到播放进度。关掉就只有歌名、来源与听感。 */
  lyrics: boolean;
  /** 只认这些播放器，逗号分隔，匹配 AUMID 或进程名的一部分；留空表示所有播放器都算。 */
  players: string;
}

export const MUSIC_DEFAULTS: MusicConfigSection = {
  enabled: false,
  pollSec: 5,
  confirmSec: 4,
  endGraceSec: 90,
  noteSec: 300,
  silentSec: 20,
  lyrics: true,
  players: '',
};

export const MUSIC_CONFIG_GROUP: ConfigGroup = {
  id: 'world:music',
  owner: 'world:music',
  schema: {
    type: 'object',
    title: '音乐伙伴',
    properties: {
      'worlds.music.pollSec': {
        type: 'integer',
        title: '采样间隔',
        description: '隔几秒读一次媒体会话与音频特征。',
        minimum: 2,
        'x-suffix': '秒',
        'x-hot': true,
      },
      'worlds.music.confirmSec': {
        type: 'integer',
        title: '确认换歌',
        description: '一首歌连续停留这么久才算真的在听，避免切歌与广告的抖动被当成换歌。',
        minimum: 0,
        'x-suffix': '秒',
        'x-hot': true,
      },
      'worlds.music.endGraceSec': {
        type: 'integer',
        title: '收尾宽限',
        description: '播放器消失或停住这么久算这一首结束；期间恢复仍算同一首。',
        minimum: 10,
        'x-suffix': '秒',
        'x-hot': true,
      },
      'worlds.music.noteSec': {
        type: 'integer',
        title: '播放中摘要',
        description: '一直在听的时候，每隔这么久告诉她一次此刻放到哪里；填 0 关闭。',
        minimum: 0,
        'x-suffix': '秒',
        'x-hot': true,
      },
      'worlds.music.silentSec': {
        type: 'integer',
        title: '抓不到声音多久后提醒',
        description: '播放器说在放、但这台电脑的音频回路上没有声音时，持续这么久就提醒她一次。',
        minimum: 5,
        'x-suffix': '秒',
        'x-hot': true,
      },
      'worlds.music.lyrics': {
        type: 'boolean',
        title: '同步歌词',
        description: '向 LRCLIB 要一份带时间轴的歌词，对齐到播放进度；只发当前这一句与下一句。',
        'x-hot': true,
      },
      'worlds.music.players': {
        type: 'string',
        title: '只认这些播放器',
        description: '逗号分隔，匹配来源应用标识或进程名的一部分；留空表示所有播放器都算。',
        'x-hot': true,
      },
    },
  },
};
