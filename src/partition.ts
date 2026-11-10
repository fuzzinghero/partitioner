import type { StructuralAnalysis } from './structural-analysis.js';
import { responseMimeIdentity } from './body.js';
import { inferFamilies } from './families.js';
import { requestScope } from './request-index.js';
import { HarError } from './parse.js';
import type { Entry, Group } from './types.js';

export type PartitionEntry = Entry & { responseHeaderFingerprint: string };

const statusIdentity = (entry: Entry) => entry.status ?? ['unavailable', entry.id];
const transportErrorIdentity = (entry: Entry) =>
  entry.transportErrorUnavailable ? ['unavailable', entry.id] : entry.transportError;
const updateRanges = (group: Group, entry: Entry) => {
  const bytes = entry.body.bytes ?? null;
  if (bytes !== null) {
    group.minBytes = Math.min(group.minBytes ?? bytes, bytes);
    group.maxBytes = Math.max(group.maxBytes ?? bytes, bytes);
  }
  if (entry.time !== null) {
    group.minTime = Math.min(group.minTime ?? entry.time, entry.time);
    group.maxTime = Math.max(group.maxTime ?? entry.time, entry.time);
  }
};
const createGroup = (id: string, label: string, entry: Entry): Group => ({
  id,
  label,
  members: [],
  variants: 0,
  status: entry.status,
  mime: entry.mime,
  minBytes: null,
  maxBytes: null,
  minTime: null,
  maxTime: null,
  representative: entry.id,
});

/** Hard boundaries apply before any body-based match, including reflection evidence. */
function responseBoundary(entry: PartitionEntry, context: string): unknown[] {
  return [
    context,
    statusIdentity(entry),
    responseMimeIdentity(entry),
    entry.responseHeaderFingerprint,
    transportErrorIdentity(entry),
  ];
}

function bodyIdentity(entry: Entry): {
  match: Group['match'];
  identity: unknown[];
  description: string | undefined;
} {
  const body = entry.body;
  if (body.shape)
    return { match: 'canonical', identity: ['canonical', body.shape], description: body.shapeKind };
  if (body.hash)
    return { match: 'exact', identity: ['exact-bytes', body.hash], description: 'exact body' };
  if (body.state === 'missing')
    return { match: 'metadata-only', identity: ['body-not-captured'], description: body.state };
  return {
    match: 'unavailable',
    identity: ['unavailable', entry.id, body.state],
    description: body.state,
  };
}

function outcomeLabel(entry: Entry, description: string | undefined): string {
  const label =
    description === 'inferred request reflection'
      ? 'likely matching response pattern'
      : description === 'exact body'
        ? 'identical body'
        : description === 'missing'
          ? 'body not captured'
          : description === 'limited'
            ? 'body exceeds analysis limit'
            : description === 'invalid'
              ? 'body could not be decoded'
              : description?.endsWith(' canonical values')
                ? `matching parsed ${description.slice(0, -17)} content`
                : (description ?? 'body unavailable');
  return `${entry.status === 0 || entry.status === null ? 'Status not captured' : entry.status} · ${entry.mime || 'content type not captured'} · ${label}`;
}

/** Assign contexts and response partitions after the complete capture is available.
 * Mutates only grouping fields on entries; captured request/response evidence stays intact. */
export function partitionEntries(
  entries: PartitionEntry[],
  providedContexts: ReadonlyMap<number, string>,
  structural?: StructuralAnalysis,
) {
  const endpoints = new Map<string, Group>();
  const outcomes = new Map<string, Group>();
  const endpointKeys = new Map<string, string>();
  const families = inferFamilies(entries);
  if ([...providedContexts.keys()].some((id) => id >= entries.length))
    throw new HarError('A context references an unavailable entry.', 'INVALID_OPTIONS');
  const familyFor = (entry: Entry): string => {
    const provided = providedContexts.get(entry.id);
    if (provided !== undefined) return provided;
    if (entry.skipped) return 'Skipped entries';
    if (!entry.url) return `Unavailable request context · entry ${entry.id + 1}`;
    const scope = requestScope(entry.contextUrl ?? entry.url).url;
    return families.get(scope) ?? scope;
  };
  const familyKey = (entry: Entry) =>
    JSON.stringify([providedContexts.has(entry.id) ? 'provided' : 'inferred', familyFor(entry)]);
  // Build exact/canonical groups first. Reflection is applied only after every strong
  // group's encoding/scaffold compatibility is known, independent of capture order.
  const exactAliases = new Map<string, Group>();
  const parents = new Map<Group, Group>();
  const rootGroup = (group: Group): Group => {
    let root = group;
    while (parents.has(root)) root = parents.get(root)!;
    while (parents.has(group)) {
      const next = parents.get(group)!;
      parents.set(group, root);
      group = next;
    }
    return root;
  };
  // Merge the smaller member list so bridge discoveries move each source at most O(log n) times.
  const joinGroups = (a: Group, b: Group): Group => {
    if (a === b) return a;
    if (a.members.length < b.members.length) [a, b] = [b, a];
    if (a.normalizations || b.normalizations)
      a.normalizations = [
        ...new Set([...(a.normalizations ?? []), ...(b.normalizations ?? [])]),
      ].sort();
    parents.set(b, a);
    outcomes.delete(b.id);
    for (const id of b.members) {
      a.members.push(id);
      entries[id].outcome = a.id;
      updateRanges(a, entries[id]);
    }
    b.members = [];
    if (
      b.match === 'inferred-reflection' ||
      (a.match !== 'inferred-reflection' && b.match === 'canonical')
    ) {
      a.match = b.match;
      a.label = b.label;
    }
    return a;
  };
  let nextOutcome = 0;
  const buckets = new Map<string, Map<string, Group>>();
  for (const entry of entries) {
    entry.family = familyFor(entry);
    entry.endpoint = endpointKeys.get(familyKey(entry)) ?? `q${endpointKeys.size}`;
    endpointKeys.set(familyKey(entry), entry.endpoint);
  }
  for (const entry of entries) {
    const endpoint =
      endpoints.get(entry.endpoint) ?? createGroup(entry.endpoint, entry.family!, entry);
    endpoint.members.push(entry.id);
    updateRanges(endpoint, entry);
    endpoints.set(entry.endpoint, endpoint);
    const familyBuckets = buckets.get(entry.endpoint) ?? new Map<string, Group>();
    buckets.set(entry.endpoint, familyBuckets);
    const { match, identity, description } = bodyIdentity(entry);
    const boundary = responseBoundary(entry, entry.endpoint);
    const key = JSON.stringify([...boundary, identity]);
    const exactKey = entry.body.hash ? JSON.stringify([...boundary, entry.body.hash]) : undefined;
    const keyed = familyBuckets.get(key);
    const aliased = exactKey ? exactAliases.get(exactKey) : undefined;
    let outcome = keyed ? rootGroup(keyed) : undefined;
    const exact = aliased ? rootGroup(aliased) : undefined;
    if (outcome && exact) outcome = joinGroups(outcome, exact);
    else outcome ??= exact;
    if (!outcome) {
      outcome = createGroup(`r${nextOutcome++}`, outcomeLabel(entry, description), entry);
      outcome.number = familyBuckets.size + 1;
      outcome.match = match;
      outcomes.set(outcome.id, outcome);
    }
    if (match === 'canonical') {
      outcome.match = 'canonical';
      outcome.label = outcomeLabel(entry, description);
    }
    familyBuckets.set(key, outcome);
    if (exactKey) exactAliases.set(exactKey, outcome);
    outcome.members.push(entry.id);
    updateRanges(outcome, entry);
    entry.outcome = outcome.id;
  }
  let ambiguousReflections = 0;
  // Shared structural analysis merges complete established groups only. Conflicting
  // interpretations within an exact/canonical group cannot bridge cohorts.
  if (structural) {
    const identities = structural.classify(entries);
    const targets = new Map<string, Group>();
    for (const group of [...outcomes.values()]) {
      const candidates = group.members.map((id) => identities.get(id));
      // Strong equality keeps unmatched aliases attached to a supported member.
      // Competing inferred explanations still cannot bridge other groups.
      const inferred = candidates.filter((c) => c && (c.reflection || c.noise));
      const reflected = inferred.filter((c) => c!.reflection);
      const supported = reflected.length ? reflected : inferred;
      const keys = new Set(supported.map((c) => JSON.stringify([c!.cohort, c!.key])));
      if (keys.size !== 1) {
        if (reflected.length > 1 && keys.size > 1) ambiguousReflections++;
        continue;
      }
      const key = [...keys][0];
      const previous = targets.get(key);
      const reflection =
        supported.some((c) => c!.reflection) || previous?.match === 'inferred-reflection';
      const noise = supported.some((c) => c!.noise) || previous?.match === 'inferred-noise';
      const target = previous ? joinGroups(rootGroup(previous), rootGroup(group)) : group;
      if (previous && target.members.length > 1) {
        if (reflection) target.match = 'inferred-reflection';
        else if (noise) target.match = 'inferred-noise';
        if (noise)
          target.normalizations = [
            ...new Set([
              ...(target.normalizations ?? []),
              ...supported.flatMap((c) => c!.normalizations),
            ]),
          ].sort();
      }
      targets.set(key, target);
    }
  }
  for (const group of outcomes.values()) {
    if (group.match === 'inferred-noise')
      group.label = outcomeLabel(
        entries[group.members[0]],
        'likely matching response pattern after diagnostic normalization',
      );
    const normalizations = new Set(group.normalizations);
    for (const id of group.members) {
      if (entries[id].body.shapeKind === 'Detected JSON canonical values')
        normalizations.add('detected-json');
      if (entries[id].body.shapeKind === 'XML canonical attributes')
        normalizations.add('xml-attributes');
    }
    if (normalizations.size) group.normalizations = [...normalizations].sort();
    group.members.sort((a, b) => a - b);
    group.representative = group.members[0];
    if (group.match === 'inferred-reflection') {
      const representative = entries[group.representative];
      group.mime = representative.mime;
      group.label = outcomeLabel(representative, 'inferred request reflection');
    }
  }
  const finalOutcomes = [...outcomes.values()].sort((a, b) => a.representative - b.representative);
  for (const group of finalOutcomes) {
    const endpoint = endpoints.get(entries[group.representative].endpoint)!;
    group.number = ++endpoint.variants;
  }

  return {
    endpoints: [...endpoints.values()],
    outcomes: finalOutcomes,
    familyInferenceLimited: families.limited,
    ambiguousReflections,
  };
}
