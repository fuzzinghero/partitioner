import type { Entry } from './types.js';

/** Public, explicit route hypotheses. No learned/private routing rules. */
export function literalTarget(url: string) {
  const match = /^([a-z][a-z\d+.-]*:\/\/[^/?#]+)([^?#]*)/i.exec(url);
  return match
    ? { origin: match[1], path: match[2] || '/' }
    : { origin: '', path: url.split(/[?#]/, 1)[0] };
}
const identifier = (value: string) =>
  /^\d+$/.test(value) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
  /^[0-9a-f]{24,64}$/i.test(value);
const fuzzSegment = (value: string) =>
  /(?:%00|%2e%2e|%27|%22|%3c|%3e|[<>"'\\]|^\.\.?$)/i.test(value);
export function inferFamilies(entries: Entry[]): Map<string, string> & { limited: boolean } {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.skipped) continue;
    const target = literalTarget(entry.contextUrl ?? entry.url);
    const url = target.origin + target.path;
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  const paths = new Set(counts.keys());
  const candidates = new Map<string, { url: string; origin: string; segments: string[] }[]>(),
    proposals = new Map<string, string>();
  let estimatedBytes = 0;
  for (const url of paths) {
    const { origin, path } = literalTarget(url),
      segments = path.split('/');
    if (segments.length < 3 || segments.length > 32) continue;
    const pattern =
      origin +
      segments
        .map((value, position) => (identifier(value) ? `{param${position}}` : value))
        .join('/');
    if (pattern === url) continue;
    estimatedBytes += 128 + (url.length + pattern.length) * 2;
    if (estimatedBytes > 8 * 1024 * 1024) break;
    const members = candidates.get(pattern) ?? [];
    members.push({ url, origin, segments });
    candidates.set(pattern, members);
  }
  for (const members of candidates.values()) {
    if (members.length < 2) continue;
    const first = members[0];
    const pattern =
      first.origin +
      first.segments
        .map((part, position) =>
          identifier(part) && members.some((m) => m.segments[position] !== part)
            ? `{param${position}}`
            : part,
        )
        .join('/');
    // A literal template-looking URL is not evidence that it names this inferred route.
    if (paths.has(pattern)) continue;
    for (const member of members) proposals.set(member.url, pattern);
  }
  // Only an existing literal anchor can absorb recognizable terminal fuzz payloads.
  for (const url of paths) {
    const { origin, path } = literalTarget(url),
      segments = path.split('/');
    if (segments.length < 4 || segments.length > 32 || !fuzzSegment(segments.at(-1) ?? ''))
      continue;
    const parent = origin + segments.slice(0, -1).join('/');
    if (paths.has(parent)) proposals.set(url, proposals.get(parent) ?? parent);
  }
  // Repeated literal endpoints can anchor payloads that introduce their own
  // slashes or are appended without a slash. A bounded trie avoids path-pair scans.
  type Node = { next: Map<string, Node>; anchor?: string };
  const roots = new Map<string, Node>();
  const fuzzSuffix = (suffix: string) =>
    /(?:[<>"'\\;]|(?:^|\/)\.\.(?:[\/;]|$)|%0[09ad]|%2e|%27|%22|%3c|%3e|\/\/|https?:\/\/)/i.test(
      suffix,
    );
  const startsPayload = (suffix: string) =>
    /^(?:[\/<>"'\\;.]|%[\da-f]{2}|https?:\/\/)/i.test(suffix);
  for (const [url, count] of counts) {
    const { origin, path } = literalTarget(url);
    if (count < 2 || path === '/' || path.split('/').length > 32 || fuzzSuffix(path)) continue;
    let node = roots.get(origin);
    if (!node) {
      node = { next: new Map() };
      roots.set(origin, node);
    }
    for (const char of path) {
      if (!node.next.has(char)) {
        estimatedBytes += 96;
        if (estimatedBytes > 8 * 1024 * 1024) break;
        node.next.set(char, { next: new Map() });
      }
      node = node.next.get(char)!;
    }
    if (estimatedBytes > 8 * 1024 * 1024) break;
    node.anchor = url;
  }
  for (const url of paths) {
    const { origin, path } = literalTarget(url);
    if (path.split('/').length > 32) continue;
    let node = roots.get(origin),
      offset = 0;
    const anchors: { url: string; offset: number }[] = [];
    for (const char of path) {
      node = node?.next.get(char);
      offset += char.length;
      if (!node) break;
      if (node.anchor && offset < path.length) anchors.push({ url: node.anchor, offset });
    }
    for (const anchor of anchors.reverse()) {
      const suffix = path.slice(anchor.offset);
      if (startsPayload(suffix) && fuzzSuffix(suffix)) {
        proposals.set(url, proposals.get(anchor.url) ?? anchor.url);
        break;
      }
    }
  }
  return Object.assign(new Map([...paths].map((path) => [path, proposals.get(path) ?? path])), {
    limited: estimatedBytes > 8 * 1024 * 1024,
  });
}
