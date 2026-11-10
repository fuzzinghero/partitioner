import { decomposeHeaders } from './header-slots.js';
import { decomposeBody, type ResponseSlot, type ResponseSlots } from './response-slots.js';
import {
  capturedRequestText,
  slotInputs,
  INPUT_LIMITS,
  inputStorageBytes,
  type InputValue,
} from './request-evidence.js';
import {
  classifyCohort,
  prepareCohortReflections,
  type CohortIdentity,
  type CohortObservation,
} from './cohort-slots.js';
import { responseMimeIdentity } from './body.js';
import { record } from './parse.js';
import type { RequestRow } from './request-index.js';
import type { Entry, NormalizationRule } from './types.js';

interface Observation extends ResponseSlots {
  inputs: readonly InputValue[];
  captured: string;
  diagnostics: readonly ResponseSlot[];
  emptyText?: ResponseSlots;
}
export interface StructuralIdentity extends CohortIdentity {
  cohort: string;
  normalizations: NormalizationRule[];
}

/** Inference data belongs to one analysis and is captured before preview eviction. */
export class StructuralAnalysis {
  readonly stats = { work: 0, entryLimited: 0, candidateLimited: 0, captureLimited: 0 };
  private observations = new Map<number, Observation>();

  observe(entry: Entry, row: RequestRow | undefined, raw: unknown): number {
    if (
      entry.skipped ||
      entry.responseMimeAmbiguous ||
      (!entry.body.hash && entry.body.state !== 'missing')
    )
      return 0;
    let inputs = slotInputs(entry, row, raw, () => this.stats.candidateLimited++);
    const rawRequest = capturedRequestText(entry, raw);
    // Application parse failure does not invalidate complete captured bytes or
    // valid response syntax. Keep only complete metadata and the whole raw body,
    // never partial application fields, as request reflection candidates.
    if (!inputs && row?.categories.has('Incomplete') && rawRequest !== undefined) {
      const categories = new Map(row.categories);
      for (const kind of ['Incomplete', 'JSON', 'XML', 'Form', 'Multipart'])
        categories.delete(kind);
      inputs = slotInputs(entry, { ...row, categories }, raw, () => this.stats.candidateLimited++);
      const candidate = { value: rawRequest, source: 'Captured raw body' };
      if (
        inputs &&
        rawRequest.length <= INPUT_LIMITS.valueChars &&
        inputs.length < INPUT_LIMITS.values &&
        inputs.reduce((n, value) => n + inputStorageBytes(value), 0) +
          inputStorageBytes(candidate) <=
          INPUT_LIMITS.bytes
      )
        inputs.push(candidate);
    }
    inputs ??= [];
    const interpret = entry.body.state === 'text' && (entry.body.bytes ?? Infinity) <= 64 * 1024;
    const content = interpret ? record(record(record(raw).response).content) : {};
    if (
      content.encoding === 'base64' &&
      typeof content.text === 'string' &&
      content.text.length > 90 * 1024
    )
      return 0;
    let text = interpret ? entry.body.text : undefined;
    if (text === undefined && typeof content.text === 'string') {
      if (content.text.length > 90 * 1024) return 0;
      try {
        text =
          content.encoding === 'base64'
            ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                Uint8Array.from(atob(content.text.replace(/[\t\n\f\r ]/g, '')), (c) =>
                  c.charCodeAt(0),
                ),
              )
            : content.text;
      } catch {
        return 0;
      }
    }
    const body = (text === undefined
      ? undefined
      : decomposeBody(
          text,
          entry.body.shapeKind === 'Detected JSON canonical values'
            ? 'application/json'
            : entry.mime,
        )) ?? {
      skeleton: JSON.stringify(['complete-body', entry.body.shape ?? entry.body.hash]),
      slots: [],
    };
    const headers = decomposeHeaders(entry, record(raw).startedDateTime);
    if (!headers) return 0;
    const combine = (body: ResponseSlots): ResponseSlots => ({
      skeleton: JSON.stringify([headers.skeleton, body.skeleton]),
      slots: [
        ...headers.slots,
        ...body.slots.map((s) => ({ ...s, path: JSON.stringify(['body', s.path]) })),
      ],
    });
    const { slots, skeleton } = combine(body);
    // A generic text response may become valid JSON when an explicit input is
    // empty (for example, a bracketed error value). Keep typed JSON primary.
    // This alternate can only extend a text reflection established by other rows.
    const alternateBody =
      entry.body.shapeKind === 'Detected JSON canonical values' &&
      /^text\/plain(?:;|$)/i.test(entry.mime) &&
      inputs.some((v) => v.value === '') &&
      text !== undefined
        ? decomposeBody(text, 'text/plain')
        : undefined;
    const emptyText = alternateBody ? combine(alternateBody) : undefined;
    this.observations.set(entry.id, {
      skeleton,
      slots,
      inputs,
      captured: JSON.stringify([entry.responseHeaders, entry.body.hash ?? 'body-not-captured']),
      emptyText,
      diagnostics: headers.diagnostics,
    });
    return (
      256 +
      2 * (JSON.stringify(entry.responseHeaders).length + (entry.body.hash?.length ?? 0)) +
      (emptyText
        ? 2 * emptyText.skeleton.length +
          emptyText.slots.reduce((n, s) => n + 96 + 2 * (s.path.length + s.value.length), 0)
        : 0) +
      headers.diagnostics.reduce((n, s) => n + 96 + 2 * (s.path.length + s.value.length), 0) +
      2 * skeleton.length +
      slots.reduce((n, s) => n + 96 + 2 * (s.path.length + s.value.length), 0) +
      inputs.reduce((n, value) => n + inputStorageBytes(value), 0)
    );
  }

  classify(entries: readonly Entry[]): Map<number, StructuralIdentity> {
    const cohorts = new Map<string, CohortObservation[]>();
    const alternatives = new Map<string, CohortObservation[]>();
    for (const entry of entries) {
      const data = this.observations.get(entry.id);
      if (!data || entry.status === null || entry.transportErrorUnavailable) continue;
      const key = (skeleton: string) =>
        JSON.stringify([
          entry.endpoint,
          entry.status,
          responseMimeIdentity(entry),
          entry.transportError,
          skeleton,
        ]);
      const observation = {
        id: entry.id,
        observation: data.captured,
        slots: data.slots,
        inputs: data.inputs,
      };
      const primaryKey = key(data.skeleton),
        rows = cohorts.get(primaryKey) ?? [];
      rows.push(observation);
      cohorts.set(primaryKey, rows);
      if (data.emptyText) {
        const alternateKey = key(data.emptyText.skeleton),
          rows = alternatives.get(alternateKey) ?? [];
        rows.push({
          ...observation,
          slots: data.emptyText.slots,
          inputs: data.inputs.filter((v) => v.value === ''),
        });
        alternatives.set(alternateKey, rows);
      }
    }
    const identities = new Map<number, StructuralIdentity>();
    const limited = new Set<number>();
    const classify = (cohort: string, rows: CohortObservation[], extension = false) => {
      const exhausted = new Set<number>();
      const onLimit = (id: number) => {
        exhausted.add(id);
        if (!limited.has(id)) {
          limited.add(id);
          this.stats.entryLimited++;
        }
      };
      const onWork = (n: number) => (this.stats.work += n);
      const work = prepareCohortReflections(
        rows.map((row) => ({
          ...row,
          slots: [...row.slots, ...this.observations.get(row.id)!.diagnostics],
        })),
        onLimit,
        onWork,
      );
      const classifyRows = (members: CohortObservation[]) =>
        classifyCohort(members, onLimit, onWork, work);
      const classified = classifyRows(rows);
      // Diagnostic header presence and occurrence counts do not define cohorts.
      // Sparse per-occurrence passes avoid a rows × union-of-header-names allocation.
      const fields = new Map<string, CohortObservation[]>();
      const capturedHeaders = new Map<number, string>();
      for (const row of rows) {
        const slots = this.observations.get(row.id)!.diagnostics;
        capturedHeaders.set(row.id, JSON.stringify(slots));
        for (const slot of slots) {
          const members = fields.get(slot.path) ?? [];
          members.push({ ...row, slots: [slot] });
          fields.set(slot.path, members);
        }
      }
      const headerNoise = new Set(capturedHeaders.values()).size > 1;
      const aliases = new Map(
        [...classified].map(([id, value]) => [
          id,
          new Map(value.reflectedValues.map((value, i) => [value, i])),
        ]),
      );
      const headerParts = new Map(rows.map((row) => [row.id, [] as unknown[]]));
      for (const path of [...fields.keys()].sort()) {
        const members = fields.get(path)!;
        if (!members.some((row) => work.matches.get(row.id)?.has(JSON.stringify([path, 'string']))))
          continue;
        for (const [id, header] of classifyRows(members)) {
          if (!header.reflection) continue;
          const bindings = aliases.get(id)!;
          const remap = (part: unknown): unknown => {
            if (Array.isArray(part)) return part.map(remap);
            if (typeof part === 'object' && part !== null && 'reflected' in part) {
              const token = part as { reflected: number; encoding: string };
              const value = header.reflectedValues[token.reflected];
              if (!bindings.has(value)) bindings.set(value, bindings.size);
              return { ...token, reflected: bindings.get(value) };
            }
            return part;
          };
          headerParts.get(id)!.push([path, remap(JSON.parse(header.key))]);
        }
      }
      for (const [id, original] of classified) {
        const parts = exhausted.has(id)
          ? ['literal', capturedHeaders.get(id)]
          : headerParts.get(id)!;
        const identity = {
          ...original,
          key: JSON.stringify([original.key, parts]),
          reflection:
            original.reflection || (!exhausted.has(id) && headerParts.get(id)!.length > 0),
          noise: original.noise || headerNoise,
          noisePaths: [
            ...original.noisePaths,
            ...(headerNoise ? [JSON.stringify(['header'])] : []),
          ],
        };
        if (extension && !identity.reflection) continue;
        identities.set(id, {
          ...identity,
          cohort,
          normalizations: [
            ...new Set(
              identity.noisePaths.map((path) => {
                const section = JSON.parse(path)[0];
                return section === 'header'
                  ? ('response-headers' as const)
                  : section === 'cookie-occurrence'
                    ? ('cookie-rotation' as const)
                    : ('response-telemetry' as const);
              }),
            ),
          ],
        });
      }
    };
    for (const [cohort, rows] of cohorts) classify(cohort, rows);
    for (const [cohort, rows] of alternatives) {
      const peers = cohorts.get(cohort);
      if (peers && peers.length >= 2) classify(cohort, [...peers, ...rows], true);
    }
    this.observations.clear();
    return identities;
  }
}
