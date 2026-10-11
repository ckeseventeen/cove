// Playlist ordering rules shared by the sidebar, the playlist page and drag and drop. Pure and unit-tested.

/** Append ids that are not in the playlist yet, keeping the existing order. */
export function appendUnique(order: string[], ids: string[]) {
  const seen = new Set(order);
  const added: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    added.push(id);
  }
  return { order: [...order, ...added], added: added.length };
}

/** Move `moving` (in their current relative order) so they sit before `beforeId`, or at the end when it is null. */
export function moveIds(order: string[], moving: string[], beforeId: string | null) {
  const set = new Set(moving);
  const moved = order.filter((id) => set.has(id));
  if (!moved.length || (beforeId !== null && set.has(beforeId))) return order;
  const rest = order.filter((id) => !set.has(id));
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  if (at < 0) return order;
  const result = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  return result.every((id, index) => id === order[index]) ? order : result;
}

/** "未命名播放列表", then "未命名播放列表 2", and so on, as in Music. */
export function untitledName(existing: string[], base = "未命名播放列表") {
  const names = new Set(existing);
  if (!names.has(base)) return base;
  let number = 2;
  while (names.has(`${base} ${number}`)) number++;
  return `${base} ${number}`;
}
