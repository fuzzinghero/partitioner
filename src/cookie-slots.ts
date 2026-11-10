import type { ResponseSlot } from './response-slots.js';

export interface CookieSlots {
  skeleton: unknown[];
  slots: ResponseSlot[];
}
/** Cookie syntax and policy are retained; only the value and eligible expiry are slots. */
export function decomposeCookie(
  value: string,
  clock: number | undefined,
  relative = true,
): CookieSlots | undefined {
  if (value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return;
  const parts = value.split(';');
  const first = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([^;\s"]*)$/.exec(parts[0]);
  if (!first) return;
  const attrs = new Map<string, string | undefined>();
  for (const part of parts.slice(1)) {
    const match = /^[ \t]*([A-Za-z][A-Za-z0-9-]*)(?:=([^;]*))?[ \t]*$/.exec(part);
    if (!match || attrs.size >= 32 || attrs.has(match[1].toLowerCase())) return;
    attrs.set(match[1].toLowerCase(), match[2]?.trim());
  }
  const age = attrs.get('max-age');
  if (attrs.has('max-age') && (age === undefined || !/^-?\d{1,9}$/.test(age))) return;
  const expires = attrs.get('expires');
  const stamp = expires === undefined ? undefined : Date.parse(expires);
  if (
    attrs.has('expires') &&
    (stamp === undefined || !Number.isFinite(stamp) || new Date(stamp).toUTCString() !== expires)
  )
    return;
  const deleted =
    age !== undefined
      ? Number(age) <= 0
      : stamp !== undefined && clock !== undefined
        ? stamp <= clock
        : stamp === 0;
  const slots: ResponseSlot[] = [
    { path: JSON.stringify(['cookie', first[1], 'value']), type: 'string', value: first[2] },
  ];
  const shape: unknown[] = [first[1], deleted ? 'deleted' : 'live-or-unspecified'];
  for (const [name, v] of attrs) {
    if (name !== 'expires' || deleted || stamp === undefined || clock === undefined) {
      shape.push([name, v]);
      continue;
    }
    const lifetime = (stamp - clock) / 1000;
    if (lifetime <= 0 || lifetime > 400 * 86400) {
      shape.push([name, v]);
      continue;
    }
    shape.push([name, 'future']);
    if (!relative) {
      slots.push({
        path: JSON.stringify(['cookie', first[1], 'expires']),
        type: 'string',
        value: v!,
      });
      continue;
    }
    slots.push({
      path: JSON.stringify(['cookie', first[1], 'expires']),
      type: 'expiry',
      value: String(lifetime),
      literal: v,
    });
  }
  return { skeleton: shape, slots };
}
