import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { MUSIC_DEFAULTS, type MusicConfigSection } from './config.ts';
import { MUSIC_TOOL_DECLS, MusicWorld } from './world.ts';

export const MUSIC: WorldDefinition<MusicConfigSection> = {
  id: 'music',
  label: 'Music Companion',
  defaults: () => ({ ...MUSIC_DEFAULTS }),
  create: (ctx) =>
    new MusicWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      dataDir: ctx.dataDir,
      persist: (patch) => ctx.persist(patch),
    }),
  describe: {
    tools: describeTools(MUSIC_TOOL_DECLS, {
      music_now: {
        zh: '报出此刻在放什么歌、来自哪个应用、放到哪，以及这段声音测出来是什么样。',
        en: 'Reports what is playing right now, where it comes from, how far in it is, and what the sound measures like.',
      },
      music_lyrics: {
        zh: '取来当前这首歌的完整歌词，来自 LRCLIB。',
        en: 'Returns the full lyric text for the current track, from LRCLIB.',
      },
      music_history: {
        zh: '报出最近几天听过哪些歌、各听了多久，读到的是本 World 自己的记录。',
        en: "Reports which tracks were listened to over the last days, from this World's own records.",
      },
    }),
    events: [
      {
        type: 'music.started',
        description: { zh: '开始播放一首歌，正文带歌名、歌手与来源应用。', en: 'A track started playing, with its title, artist and source app.' },
      },
      {
        type: 'music.track_changed',
        description: { zh: '换成另一首歌，正文带上一首是什么。', en: 'A different track took over; the previous one comes with it.' },
      },
      {
        type: 'music.resumed',
        description: { zh: '暂停后又接着放，正文带从哪儿接上、正在唱的那一句。', en: 'Playback resumed, with the position it resumed from and the lyric line being sung.' },
      },
      {
        type: 'music.paused',
        description: { zh: '暂停了，正文带停在哪一秒。', en: 'Playback paused, with the position it stopped at.' },
      },
      {
        type: 'music.stopped',
        description: { zh: '这一首结束，正文带实际放了多久。', en: 'The track ended, with how long it actually played.' },
      },
      {
        type: 'music.note',
        description: { zh: '一直在听的时候每隔一段时间递一份此刻的完整快照。', en: 'A full snapshot of what is playing, handed over every so often while the music continues.' },
      },
      {
        type: 'music.silent',
        description: {
          zh: '播放器说正在放，但这台电脑的音频回路上没有声音经过（受保护内容、独占输出或走了别的设备），每首一次。',
          en: 'The player reports playing, but no sound passes through this machine\'s audio path — protected content, an exclusive-mode player, or another output device. Once per track.',
        },
      },
    ],
  },
};
