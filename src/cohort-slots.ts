import type { ResponseSlot } from './response-slots.js';
import { distributionValue, valueGrammar } from './value-grammar.js';

export type SlotClassification = 'constant' | 'volatile' | 'behavioral';

/** Caller supplies distinct complete observations, not frequency-weighted replay rows. */
export function classifyVariance(
  slots: readonly ResponseSlot[],
  volatilePeer = false,
): SlotClassification {
  if (!slots.length) return 'behavioral';
  const values = new Set(slots.map((s) => s.value));
  if (values.size === 1) return 'constant';
  const type = slots[0].type;
  if (!slots.every((s) => s.type === type) || !['string', 'number'].includes(type))
    return 'behavioral';
  const grammars = slots.map((s) => (s.type === 'number' ? undefined : valueGrammar(s.value)));
  if (grammars[0] && grammars.every((g) => g === grammars[0])) return 'volatile';
  if (grammars.every(Boolean)) return 'behavioral';
  if (
    ((slots.every(
      (s) =>
        s.type === 'number' ||
        (s.type === 'string' && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s.value)),
    ) &&
      (values.size >= 4 || volatilePeer)) ||
      (values.size >= 4 && values.size / slots.length >= 0.75)) &&
    slots.every((s) => distributionValue(s.value, type))
  )
    return 'volatile';
  return 'behavioral';
}

import {
  prepareReflections,
  reflectPreparedSlot,
  selectReflection,
  type SlotTemplate,
} from './slot-reflection.js';
import type { InputValue } from './request-evidence.js';
import { projectSlot, type SlotProjection } from './slot-projection.js';

export interface CohortObservation {
  id: number;
  /** Complete captured response identity; repeated observations do not add statistical weight. */
  observation: string;
  slots: readonly ResponseSlot[];
  inputs: readonly InputValue[];
}
export interface CohortIdentity {
  key: string;
  reflection: boolean;
  noise: boolean;
  noisePaths: string[];
  /** Canonical reflected values in alias order; used to preserve cross-section relationships. */
  reflectedValues: string[];
}

const slotIdentity = (slot: ResponseSlot) => JSON.stringify([slot.path, slot.type]);
export interface CohortWork {
  remaining: Map<number, number>;
  matches: Map<number, Map<string, SlotTemplate>>;
}

/** Match all sparse body/header slots once per entry, sharing one bounded allowance. */
export function prepareCohortReflections(
  rows: readonly CohortObservation[],
  onLimit?: (id: number) => void,
  onWork?: (units: number) => void,
): CohortWork {
  const values = new Map<string, string>();
  const varying = new Set<string>();
  for (const row of rows)
    for (const slot of row.slots) {
      const key = slotIdentity(slot);
      if (values.has(key) && values.get(key) !== slot.value) varying.add(key);
      else values.set(key, slot.value);
    }
  const remaining = new Map(rows.map((row) => [row.id, 1024 * 1024]));
  const matches = new Map<number, Map<string, SlotTemplate>>();
  for (const row of rows) {
    const spend = (n: number) => {
      onWork?.(n);
      const before = remaining.get(row.id)!;
      remaining.set(row.id, before - n);
      if (before >= 0 && before - n < 0) onLimit?.(row.id);
      return before - n >= 0;
    };
    const eligible = row.slots.filter(
      (slot) => varying.has(slotIdentity(slot)) && ['string', 'number', 'key'].includes(slot.type),
    );
    const prepared = prepareReflections(eligible.length ? row.inputs : [], spend);
    const proposals = new Map<string, SlotTemplate>();
    for (const slot of eligible) {
      if (!prepared || remaining.get(row.id)! < 0) break;
      const match = reflectPreparedSlot(slot.value, prepared, spend);
      if (
        match &&
        (slot.type !== 'key' ||
          (match.spans.length === 1 &&
            match.spans[0].start === 0 &&
            match.spans[0].end === slot.value.length))
      )
        proposals.set(slotIdentity(slot), match);
    }
    if (remaining.get(row.id)! < 0) proposals.clear();
    matches.set(row.id, proposals);
  }
  return { remaining, matches };
}

/** Classify complete slots first, then compare bounded literal token profiles.
 * Reflected observations never vote in the unmatched population's variance. */
export function classifyCohort(
  rows: readonly CohortObservation[],
  onLimit?: (id: number) => void,
  onWork?: (units: number) => void,
  work?: CohortWork,
): Map<number, CohortIdentity> {
  const result = new Map<number, CohortIdentity>();
  if (!rows.length) return result;
  const paths = rows[0].slots.map(slotIdentity);
  if (
    rows.some(
      (r) =>
        r.slots.length !== paths.length || r.slots.some((s, i) => slotIdentity(s) !== paths[i]),
    )
  )
    return result;
  const varying = paths.map((_, i) => new Set(rows.map((r) => r.slots[i].value)).size > 1);
  const proposals = new Map<number, Map<number, SlotTemplate>>();
  work ??= prepareCohortReflections(rows, onLimit, onWork);
  const remaining = work.remaining;
  const limited = new Set(rows.filter((row) => remaining.get(row.id)! < 0).map((row) => row.id));
  const spend = (id: number, n: number) => {
    onWork?.(n);
    remaining.set(id, remaining.get(id)! - n);
    if (remaining.get(id)! >= 0) return true;
    if (!limited.has(id)) {
      limited.add(id);
      onLimit?.(id);
    }
    return false;
  };
  for (const row of rows) {
    const matches = new Map<number, SlotTemplate>();
    if (!limited.has(row.id))
      for (let i = 0; i < paths.length; i++) {
        const match = work.matches.get(row.id)?.get(paths[i]);
        if (varying[i] && match) matches.set(i, match);
      }
    proposals.set(row.id, matches);
  }
  const states = new Map(
    rows.map((r) => [
      r.id,
      {
        parts: [] as unknown[],
        reflection: false,
        noise: false,
        noisePaths: [] as string[],
        aliases: new Map<string, number>(),
      },
    ]),
  );
  const markNoise = (id: number, path: string) => {
    const state = states.get(id)!;
    state.noise = true;
    state.noisePaths.push(path);
  };
  for (let index = 0; index < paths.length; index++) {
    const slot = rows[0].slots[index];
    if (slot.type === 'expiry') {
      const absolute = new Set(rows.map((r) => r.slots[index].literal));
      if (absolute.size === 1) {
        for (const row of rows)
          states.get(row.id)!.parts.push(['expiry-absolute', row.slots[index].literal]);
        continue;
      }
      const values = [
        ...new Set(rows.map((r) => Number(r.slots[index].value)).filter(Number.isFinite)),
      ].sort((a, b) => a - b);
      const anchors = new Map<number, number>();
      let anchor = -Infinity;
      for (const value of values) {
        if (value - anchor > 2) anchor = value;
        anchors.set(value, anchor);
      }
      const merged = new Map<number, Set<string | undefined>>();
      for (const row of rows) {
        const s = row.slots[index],
          a = anchors.get(Number(s.value));
        if (a === undefined) continue;
        const set = merged.get(a) ?? new Set();
        set.add(s.literal);
        merged.set(a, set);
      }
      for (const row of rows) {
        const s = row.slots[index],
          a = anchors.get(Number(s.value));
        states
          .get(row.id)!
          .parts.push(a === undefined ? ['expiry-absolute', s.literal] : ['expiry', a]);
        if (a !== undefined && merged.get(a)!.size > 1) markNoise(row.id, s.path);
      }
      continue;
    }
    if (!varying[index]) {
      for (const row of rows)
        states.get(row.id)!.parts.push(['literal', slot.type, row.slots[index].value]);
      continue;
    }
    const support = new Map<string, { values: Set<string> }>();
    const projected = new Map<number, SlotProjection>();
    for (const row of rows) {
      const match = proposals.get(row.id)?.get(index);
      if (!match) continue;
      const projection = projectSlot(row.slots[index].value, match);
      if (!projection) continue;
      projected.set(row.id, projection);
      const key = JSON.stringify(projection.shape),
        stat = support.get(key) ?? { values: new Set<string>() };
      stat.values.add(JSON.stringify(projection.reflection!.values));
      support.set(key, stat);
    }
    const emptyProfiles = new Map<
      string,
      Map<string, { projection: SlotProjection; sources: Set<string> }>
    >();
    for (const projection of projected.values()) {
      const template = projection.reflection!;
      if (
        template.values.length !== 1 ||
        support.get(JSON.stringify(projection.shape))!.values.size < 2
      )
        continue;
      const emptyText = template.parts.filter((p) => typeof p === 'string').join('');
      const empty = projectSlot(emptyText, { ...template, values: [''], spans: [] });
      if (!empty) continue;
      const key = JSON.stringify(empty.shape),
        variants = emptyProfiles.get(emptyText) ?? new Map();
      const variant = variants.get(key) ?? { projection: empty, sources: new Set<string>() };
      template.sources.flat().forEach((source) => variant.sources.add(source));
      variants.set(key, variant);
      emptyProfiles.set(emptyText, variants);
    }
    const choices: { row: CohortObservation; projection: SlotProjection }[] = [];
    for (const row of rows) {
      const value = row.slots[index].value;
      let projection = projected.get(row.id);
      if (projection && support.get(JSON.stringify(projection.shape))!.values.size < 2)
        projection = undefined;
      if (!projection && slot.type !== 'key') {
        const match = projected.get(row.id)?.reflection;
        if (match && match.spans.length > 1 && !limited.has(row.id)) {
          const compatible = new Map<string, SlotProjection>();
          const attempt = (
            keep: (span: { start: number; end: number }, index: number) => boolean,
          ) => {
            if (!spend(row.id, value.length + match.spans.length)) return;
            const subset = selectReflection(value, match, keep);
            const discarded = match.spans.filter((span, i) => !keep(span, i));
            const candidate = subset && projectSlot(value, subset, discarded);
            if (
              candidate &&
              (support.get(JSON.stringify(candidate.shape))?.values.size ?? 0) >= 2
            ) {
              if (!spend(row.id, candidate.values.length * (discarded.length + 1))) return;
              compatible.set(
                JSON.stringify([
                  candidate.shape,
                  candidate.values,
                  candidate.reflection!.values,
                  candidate.literalTokens,
                ]),
                candidate,
              );
            }
          };
          // Bounded alternatives: keep/drop one input's occurrences, or keep one span.
          // Existing confirmed profiles are frozen; these alternatives cannot bootstrap support.
          for (let alias = 0; alias < match.values.length && !limited.has(row.id); alias++) {
            const matches = (_: unknown, i: number) => {
              const part = match.parts[i * 2 + 1];
              return typeof part !== 'string' && part.reflected === alias;
            };
            attempt(matches);
            attempt((span, i) => !matches(span, i));
          }
          for (let i = 0; i < match.spans.length && !limited.has(row.id); i++)
            attempt((_, j) => i === j);
          if (!limited.has(row.id) && compatible.size === 1)
            projection = [...compatible.values()][0];
        }
      }
      if (!projection && ['string', 'key'].includes(slot.type)) {
        const emptySources = new Set(row.inputs.filter((v) => v.value === '').map((v) => v.source));
        const compatible = [...(emptyProfiles.get(value)?.values() ?? [])].filter((p) =>
          [...p.sources].some((source) => emptySources.has(source)),
        );
        if (compatible.length === 1) projection = compatible[0].projection;
      }
      if (!projection) {
        const copies = projected.get(row.id)?.reflection?.spans ?? [];
        projection =
          slot.type === 'string'
            ? projectSlot(value, undefined, copies)
            : {
                shape: [{ token: 0 }],
                values: [value],
                ...(copies.length ? { literalTokens: [true] } : {}),
              };
        if (projection && copies.length && !spend(row.id, projection.values.length * copies.length))
          projection = undefined;
      }
      if (!projection) {
        states.get(row.id)!.parts.push(['literal', slot.type, value]);
        continue;
      }
      choices.push({ row, projection });
    }
    // Independently supported format noise remains the same server pattern when
    // another request copies the complete token. Reflections never establish this evidence.
    const copiedObservations = new Set(
      rows.filter((row) => projected.has(row.id)).map((row) => row.observation),
    );
    const unmatched = [
      ...new Map(
        choices
          .filter((c) => !c.projection.reflection && !copiedObservations.has(c.row.observation))
          .map((c) => [c.row.observation, c.row.slots[index]]),
      ).values(),
    ];
    const format = unmatched.length ? valueGrammar(unmatched[0].value) : undefined;
    if (slot.type === 'string' && format && classifyVariance(unmatched) === 'volatile')
      for (const choice of choices) {
        const value = choice.row.slots[index].value;
        if (
          (!choice.projection.reflection && !choice.projection.literalTokens?.some(Boolean)) ||
          (choice.projection.reflection && choice.projection.literalTokens?.some(Boolean)) ||
          valueGrammar(value) !== format
        )
          continue;
        const base = projectSlot(value);
        if (base?.values.length === 1 && base.values[0] === value) choice.projection = base;
      }
    const profiles = new Map<string, typeof choices>();
    for (const choice of choices) {
      const key = JSON.stringify([Boolean(choice.projection.reflection), choice.projection.shape]);
      const group = profiles.get(key) ?? [];
      group.push(choice);
      profiles.set(key, group);
    }
    for (const members of profiles.values()) {
      const distinct = [...new Map(members.map((m) => [m.row.observation, m])).values()];
      // Identical captured responses add one statistical observation. Any known
      // copy exclusion belongs to that observation, independent of replay order.
      const excluded = new Map<string, Set<number>>();
      for (const member of members)
        for (const [index, literal] of member.projection.literalTokens?.entries() ?? []) {
          if (!literal) continue;
          const tokens = excluded.get(member.row.observation) ?? new Set<number>();
          tokens.add(index);
          excluded.set(member.row.observation, tokens);
        }
      const populations = members[0].projection.values.map((_, i) =>
        distinct
          .filter((m) => !excluded.get(m.row.observation)?.has(i))
          .map((m) => ({
            path: slot.path,
            type: slot.type,
            value: m.projection.values[i],
          })),
      );
      const variance = populations.map((population) => classifyVariance(population));
      const independentFormats = populations.map((population) => {
        const format =
          population[0]?.type === 'string' ? valueGrammar(population[0].value) : undefined;
        return format && population.every((slot) => valueGrammar(slot.value) === format)
          ? format
          : undefined;
      });
      if (variance.includes('volatile'))
        for (let i = 0; i < variance.length; i++)
          if (variance[i] === 'behavioral') variance[i] = classifyVariance(populations[i], true);
      for (const { row, projection } of members) {
        const state = states.get(row.id)!;
        const parts = projection.shape.map((part) => {
          if (typeof part === 'string') return part;
          if ('token' in part) {
            if (
              variance[part.token] === 'volatile' &&
              (!projection.literalTokens?.[part.token] ||
                (!projection.reflection &&
                  independentFormats[part.token] &&
                  valueGrammar(projection.values[part.token]) === independentFormats[part.token]))
            ) {
              markNoise(row.id, slot.path);
              return ['volatile', slot.type];
            }
            return ['literal', slot.type, projection.values[part.token]];
          }
          const value = projection.reflection!.values[part.reflected];
          let alias = state.aliases.get(value);
          if (alias === undefined) {
            alias = state.aliases.size;
            state.aliases.set(value, alias);
          }
          state.reflection = true;
          return { ...part, reflected: alias };
        });
        state.parts.push(['slot', slot.type, parts]);
      }
    }
  }
  for (const row of rows) {
    const state = states.get(row.id)!;
    result.set(row.id, {
      key: JSON.stringify(state.parts),
      reflection: state.reflection,
      noise: state.noise,
      noisePaths: [...new Set(state.noisePaths)],
      reflectedValues: [...state.aliases.keys()],
    });
  }
  return result;
}
