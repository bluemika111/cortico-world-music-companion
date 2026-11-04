/**
 * 「播放器」面板：列出此刻系统里认识的播放器，勾上就只认这些。
 * 一个都不勾表示所有播放器都算；勾选写进 `worlds.music.players`。
 */
import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';

interface ScanRow {
  app: string;
  title: string;
  playing: boolean;
}

interface ScanReply {
  rows: ScanRow[];
  selected: string[];
  note?: string;
}

const TEXT = {
  zh: {
    title: '播放器',
    desc: '此刻系统里在出声或被识别到的播放器。勾上就只认这些；一个都不勾表示所有播放器都算。',
    scan: '扫描播放器',
    save: '保存勾选',
    app: '应用',
    now: '此刻',
    empty: '还没有扫描。点「扫描播放器」看现在有什么在放。',
    scanning: '正在读取系统媒体会话…',
    saving: '正在保存…',
    saved: (n: number) => (n === 0 ? '已清空名单：所有播放器都算。' : `已保存 ${n} 个播放器。`),
    failed: '扫描失败',
    playing: '正在播放',
    idle: '没在播',
    nothing: '没有检测到在放歌的播放器。打开播放器放一首，再扫描一次。',
  },
  en: {
    title: 'Players',
    desc: 'Players that are audible or recognised right now. Ticked means only those count; none ticked means any player.',
    scan: 'Scan players',
    save: 'Save ticks',
    app: 'App',
    now: 'Now',
    empty: 'Nothing scanned yet. Press “Scan players”.',
    scanning: 'Reading system media sessions…',
    saving: 'Saving…',
    saved: (n: number) => (n === 0 ? 'Cleared: every player counts.' : `Saved ${n} player${n === 1 ? '' : 's'}.`),
    failed: 'Scan failed',
    playing: 'Playing',
    idle: 'Idle',
    nothing: 'No player is playing anything. Start one and scan again.',
  },
} as const;

export const playersPanel: WebUiPanel = {
  mount: async (ctx: WebUiPanelContext) => {
    const { ui, root } = ctx;
    const S = ctx.language === 'en' ? TEXT.en : TEXT.zh;

    const card = ui.sheet({ title: S.title, desc: S.desc });
    const message = ui.msgline(S.empty);
    const scanButton = ui.button(S.scan, { variant: 'primary' });
    const saveButton = ui.button(S.save, { variant: 'primary' });
    const bar = ui.rowbar();
    bar.append(scanButton, saveButton, message);
    const table = ui.table({ head: ['', S.app, S.now], maxHeight: 'calc(100vh - 320px)' });
    card.body.append(bar, table.el);
    root.append(card.el);

    let rows: ScanRow[] = [];
    let checked = new Set<string>();

    saveButton.disabled = true;

    const note = (text: string, bad = false) => {
      message.textContent = text;
      message.classList.toggle('bad', bad);
    };

    const render = () => {
      table.clear(rows.length === 0 ? S.empty : undefined);
      for (const row of rows) {
        const box = ui.checkbox('', {
          checked: checked.has(row.app),
          onChange: (on) => {
            if (on) checked.add(row.app);
            else checked.delete(row.app);
            saveButton.disabled = false;
          },
        });
        box.input.setAttribute('aria-label', row.app);
        const now = row.playing
          ? row.title
            ? `${S.playing} · ${row.title}`
            : S.playing
          : S.idle;
        const added = table.addRow([box.el, { text: row.app, cls: 'mono' }, now]);
        added.dataset.app = row.app;
      }
    };

    const scan = async () => {
      const release = ui.disable(scanButton, saveButton);
      note(S.scanning);
      try {
        const reply = await ctx.invoke<ScanReply>('scan');
        rows = Array.isArray(reply.rows) ? reply.rows : [];
        checked = new Set(Array.isArray(reply.selected) ? reply.selected : []);
        saveButton.disabled = rows.length === 0;
        const text = reply.note ?? (rows.length === 0 ? S.nothing : S.empty);
        note(text);
        render();
      } catch (error) {
        note(`${S.failed}: ${String(error)}`, true);
      } finally {
        release.dispose();
      }
    };

    const save = async () => {
      const release = ui.disable(scanButton, saveButton);
      note(S.saving);
      const picks = rows.filter((row) => checked.has(row.app)).map((row) => row.app);
      try {
        await ctx.invoke('save', [{ picks }]);
        note(S.saved(picks.length));
      } catch (error) {
        note(String(error), true);
      } finally {
        release.dispose();
      }
    };

    scanButton.addEventListener('click', () => void scan(), { signal: ctx.signal });
    saveButton.addEventListener('click', () => void save(), { signal: ctx.signal });

    render();
  },
};

export default { panels: { players: playersPanel } };
