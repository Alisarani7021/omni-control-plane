import { describe, expect, it } from "vitest";
import {
  findHelpTopic,
  HELP_TOPICS,
  helpIndexKeyboard,
  helpIndexText,
  helpTopicKeyboard,
  helpTopicText,
} from "../src/help-topics";

describe("help topics", () => {
  it("keeps ids unique and labels short enough for a button", () => {
    const ids = HELP_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const topic of HELP_TOPICS) {
      expect(topic.label.length).toBeLessThanOrEqual(30);
      expect(topic.lines.length).toBeGreaterThan(2);
      // Telegram caps a message at 4096 chars; leave room for the keyboard and headers.
      expect(helpTopicText(topic).length).toBeLessThan(3_500);
    }
  });

  it("puts one button per topic and always offers the way home", () => {
    const keyboard = helpIndexKeyboard();
    const buttons = keyboard.inline_keyboard.flat();
    for (const topic of HELP_TOPICS) {
      expect(buttons).toContainEqual({ text: topic.label, callback_data: `v13:help:${topic.id}` });
    }
    expect(buttons.at(-1)?.callback_data).toBe("omni:home");
    expect(buttons).toHaveLength(HELP_TOPICS.length + 1);
    for (const row of keyboard.inline_keyboard.slice(0, -1)) expect(row.length).toBeLessThanOrEqual(2);
  });

  it("index text mentions every section by name", () => {
    const text = helpIndexText();
    for (const topic of HELP_TOPICS) expect(text).toContain(topic.label);
  });

  it("looks topics up by id and offers a way back to the index", () => {
    expect(findHelpTopic("radar")?.title).toContain("رادار");
    expect(findHelpTopic("does-not-exist")).toBeNull();
    const topic = HELP_TOPICS[0];
    expect(topic).toBeDefined();
    if (topic) {
      expect(helpTopicText(topic)).toContain(topic.title);
      expect(helpTopicText(topic)).toContain(topic.lines[0]);
    }
    expect(helpTopicKeyboard().inline_keyboard.flat().map((button) => button.callback_data))
      .toEqual(["v13:help", "omni:home"]);
  });

  it("documents retention windows and never advertises invented features", () => {
    const all = HELP_TOPICS.map((topic) => topic.lines.join("\n")).join("\n");
    expect(all).toContain("۷ روز");
    expect(all).toContain("۲۴ ساعت");
    expect(all).toContain("۳۰ روز");
    // Nothing here may read like a marketing claim copied from the old worker.
    expect(all).not.toMatch(/غول فعال|RUM-based|۱۱ لایه/u);
    expect(all).not.toMatch(/آپ‌تایم [\d۹۸۷۶۵۴۳۲۱۰]/u);
  });
});
