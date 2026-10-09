"use strict";
/**
 * Who is asking, as the phone shows it. The agent chooses its own name and icon, so both are
 * treated as untrusted text: cleaned, shortened, and the icon limited to a fixed list of
 * presets or a single emoji. An icon is never a web address, so the phone never fetches
 * anything an agent points it at.
 */

const DEFAULT_NAME = "Unnamed agent";
const MAX_NAME = 60;
const MAX_ICON_CODEPOINTS = 8;

/** Names an agent may use for its icon. The phone maps each to a drawing of its own. */
const ICON_PRESETS = ["code", "terminal", "sparkles", "chat", "search", "globe", "flash", "cube"];

// Control characters, zero-width characters and the text-direction overrides that can make
// one name read as another. Listed as code point ranges.
const HIDDEN_RANGES = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];

function isHidden(code) {
  return HIDDEN_RANGES.some(([from, to]) => code >= from && code <= to);
}

/** Hidden characters become spaces, so "a<zero width>b" cannot pass as one word. */
function blankHidden(text) {
  return Array.from(text, (letter) => (isHidden(letter.codePointAt(0)) ? " " : letter)).join("");
}

function clip(text, max) {
  const letters = Array.from(text);
  return letters.length > max ? letters.slice(0, max).join("") : text;
}

/** A plain, single-line name of at most 60 characters, or "Unnamed agent". */
function cleanAgentName(value) {
  if (typeof value !== "string") return DEFAULT_NAME;
  const text = clip(blankHidden(value).replace(/\s+/g, " ").trim(), MAX_NAME).trim();
  return text || DEFAULT_NAME;
}

function isEmojiCodepoint(code) {
  return (
    (code >= 0x1f000 && code <= 0x1faff) || // pictographs, emoticons, flags, symbols
    (code >= 0x2600 && code <= 0x27bf) || // misc symbols, dingbats
    (code >= 0x2300 && code <= 0x23ff) || // technical (watch, hourglass)
    (code >= 0x2b00 && code <= 0x2bff) || // stars, squares
    code === 0xfe0f || // emoji presentation
    code === 0x200d // joiner, for sequences like a person at a laptop
  );
}

/**
 * @returns {{ kind: "preset", name: string } | { kind: "emoji", value: string } | null}
 */
function cleanAgentIcon(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const preset = text.toLowerCase();
  if (ICON_PRESETS.includes(preset)) return { kind: "preset", name: preset };
  const letters = Array.from(text);
  if (letters.length > MAX_ICON_CODEPOINTS) return null;
  const codes = letters.map((letter) => letter.codePointAt(0));
  if (!codes.every(isEmojiCodepoint)) return null;
  // Joiners and variation selectors alone are not a picture.
  if (!codes.some((code) => code !== 0x200d && code !== 0xfe0f)) return null;
  return { kind: "emoji", value: text };
}

/** Name and icon from a request payload. */
function describeAgent(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  return { name: cleanAgentName(source.agent), icon: cleanAgentIcon(source.agentIcon) };
}

module.exports = { DEFAULT_NAME, ICON_PRESETS, cleanAgentName, cleanAgentIcon, describeAgent };
