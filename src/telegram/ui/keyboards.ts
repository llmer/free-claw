/**
 * Shared keyboard builders for Telegram inline keyboards.
 */

import { InlineKeyboard } from "grammy";

/**
 * Build a grid of buttons from [label, callbackData] pairs.
 * `columns` controls how many buttons per row (default 2).
 */
export function buildGrid(
  items: [label: string, data: string][],
  columns = 2,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < items.length; i++) {
    kb.text(items[i][0], items[i][1]);
    if ((i + 1) % columns === 0 || i === items.length - 1) {
      kb.row();
    }
  }
  return kb;
}

/**
 * Build a grid and append a custom option row at the bottom.
 */
export function buildGridWithCustom(
  items: [label: string, data: string][],
  customData: string,
  columns = 2,
  customLabel = "Type your own...",
): InlineKeyboard {
  const kb = buildGrid(items, columns);
  kb.text(customLabel, customData);
  return kb;
}

export function backButton(data: string, label = "« Back"): InlineKeyboard {
  return new InlineKeyboard().text(label, data);
}

export function confirmCancel(
  confirmData: string,
  cancelData: string,
  confirmLabel = "Confirm",
  cancelLabel = "Start over",
): InlineKeyboard {
  return new InlineKeyboard()
    .text(confirmLabel, confirmData)
    .text(cancelLabel, cancelData);
}
