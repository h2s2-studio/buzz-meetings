type Source = { id: string; name: string };

// Same-name people keep a stable, matching suffix in the roster and transcript.
// Extend it if two sources happen to share the short suffix.
export function speakerLabels(sources: Iterable<Source>) {
  const names = new Map<string, Set<string>>();
  const key = (name: string) => name.normalize("NFKC").toLocaleLowerCase();
  for (const source of sources) {
    const name = key(source.name), peers = names.get(name) ?? new Set<string>();
    peers.add(source.id); names.set(name, peers);
  }
  return (source: Source) => {
    const peers = names.get(key(source.name));
    if (!peers || peers.size < 2) return source.name;
    let length = Math.min(6, source.id.length);
    while (length < source.id.length && [...peers].some(id => id !== source.id && id.endsWith(source.id.slice(-length)))) length++;
    return `${source.name} · ${source.id.slice(-length)}`;
  };
}
