"use strict";
/**
 * Splits the history into "Today", "Yesterday" and "Earlier", newest first, by the phone's own
 * calendar days. Pure, so the day boundaries can be tested.
 */

function startOfDay(time) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * @param entries anything with a timestamp
 * @param now     current time in ms
 * @param timeOf  how to read an entry's time in ms
 * @returns {{ label: "Today" | "Yesterday" | "Earlier", entries: any[] }[]} empty groups left out
 */
function groupByDay(entries, now, timeOf) {
  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = [
    { label: "Today", entries: [] },
    { label: "Yesterday", entries: [] },
    { label: "Earlier", entries: [] },
  ];
  const sorted = [...entries].sort((a, b) => timeOf(b) - timeOf(a));
  for (const entry of sorted) {
    const time = timeOf(entry);
    if (time >= today.getTime()) groups[0].entries.push(entry);
    else if (time >= yesterday.getTime()) groups[1].entries.push(entry);
    else groups[2].entries.push(entry);
  }
  return groups.filter((group) => group.entries.length > 0);
}

module.exports = { groupByDay };
