// src/webui/client.ts
var TEXT = {
  zh: {
    title: "\u64AD\u653E\u5668",
    desc: "\u6B64\u523B\u7CFB\u7EDF\u91CC\u5728\u51FA\u58F0\u6216\u88AB\u8BC6\u522B\u5230\u7684\u64AD\u653E\u5668\u3002\u52FE\u4E0A\u5C31\u53EA\u8BA4\u8FD9\u4E9B\uFF1B\u4E00\u4E2A\u90FD\u4E0D\u52FE\u8868\u793A\u6240\u6709\u64AD\u653E\u5668\u90FD\u7B97\u3002",
    scan: "\u626B\u63CF\u64AD\u653E\u5668",
    save: "\u4FDD\u5B58\u52FE\u9009",
    app: "\u5E94\u7528",
    now: "\u6B64\u523B",
    empty: "\u8FD8\u6CA1\u6709\u626B\u63CF\u3002\u70B9\u300C\u626B\u63CF\u64AD\u653E\u5668\u300D\u770B\u73B0\u5728\u6709\u4EC0\u4E48\u5728\u653E\u3002",
    scanning: "\u6B63\u5728\u8BFB\u53D6\u7CFB\u7EDF\u5A92\u4F53\u4F1A\u8BDD\u2026",
    saving: "\u6B63\u5728\u4FDD\u5B58\u2026",
    saved: (n) => n === 0 ? "\u5DF2\u6E05\u7A7A\u540D\u5355\uFF1A\u6240\u6709\u64AD\u653E\u5668\u90FD\u7B97\u3002" : `\u5DF2\u4FDD\u5B58 ${n} \u4E2A\u64AD\u653E\u5668\u3002`,
    failed: "\u626B\u63CF\u5931\u8D25",
    playing: "\u6B63\u5728\u64AD\u653E",
    idle: "\u6CA1\u5728\u64AD",
    nothing: "\u6CA1\u6709\u68C0\u6D4B\u5230\u5728\u653E\u6B4C\u7684\u64AD\u653E\u5668\u3002\u6253\u5F00\u64AD\u653E\u5668\u653E\u4E00\u9996\uFF0C\u518D\u626B\u63CF\u4E00\u6B21\u3002"
  },
  en: {
    title: "Players",
    desc: "Players that are audible or recognised right now. Ticked means only those count; none ticked means any player.",
    scan: "Scan players",
    save: "Save ticks",
    app: "App",
    now: "Now",
    empty: "Nothing scanned yet. Press \u201CScan players\u201D.",
    scanning: "Reading system media sessions\u2026",
    saving: "Saving\u2026",
    saved: (n) => n === 0 ? "Cleared: every player counts." : `Saved ${n} player${n === 1 ? "" : "s"}.`,
    failed: "Scan failed",
    playing: "Playing",
    idle: "Idle",
    nothing: "No player is playing anything. Start one and scan again."
  }
};
var playersPanel = {
  mount: async (ctx) => {
    const { ui, root } = ctx;
    const S = ctx.language === "en" ? TEXT.en : TEXT.zh;
    const card = ui.sheet({ title: S.title, desc: S.desc });
    const message = ui.msgline(S.empty);
    const scanButton = ui.button(S.scan, { variant: "primary" });
    const saveButton = ui.button(S.save, { variant: "primary" });
    const bar = ui.rowbar();
    bar.append(scanButton, saveButton, message);
    const table = ui.table({ head: ["", S.app, S.now], maxHeight: "calc(100vh - 320px)" });
    card.body.append(bar, table.el);
    root.append(card.el);
    let rows = [];
    let checked = /* @__PURE__ */ new Set();
    saveButton.disabled = true;
    const note = (text, bad = false) => {
      message.textContent = text;
      message.classList.toggle("bad", bad);
    };
    const render = () => {
      table.clear(rows.length === 0 ? S.empty : void 0);
      for (const row of rows) {
        const box = ui.checkbox("", {
          checked: checked.has(row.app),
          onChange: (on) => {
            if (on) checked.add(row.app);
            else checked.delete(row.app);
            saveButton.disabled = false;
          }
        });
        box.input.setAttribute("aria-label", row.app);
        const now = row.playing ? row.title ? `${S.playing} \xB7 ${row.title}` : S.playing : S.idle;
        const added = table.addRow([box.el, { text: row.app, cls: "mono" }, now]);
        added.dataset.app = row.app;
      }
    };
    const scan = async () => {
      const release = ui.disable(scanButton, saveButton);
      note(S.scanning);
      try {
        const reply = await ctx.invoke("scan");
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
        await ctx.invoke("save", [{ picks }]);
        note(S.saved(picks.length));
      } catch (error) {
        note(String(error), true);
      } finally {
        release.dispose();
      }
    };
    scanButton.addEventListener("click", () => void scan(), { signal: ctx.signal });
    saveButton.addEventListener("click", () => void save(), { signal: ctx.signal });
    render();
  }
};
var client_default = { panels: { players: playersPanel } };
export {
  client_default as default,
  playersPanel
};
