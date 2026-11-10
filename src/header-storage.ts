import type { Header } from './types.js';

/** Share immutable captured header values, retaining occurrence/order in each entry's array. */
export class HeaderStorage {
  private values = new Map<string, { header: Header; bytes: number }>();
  private bytes = 0;
  private peak = 0;
  retain(headers: Header[]): number {
    let added = 24 + headers.length * 8;
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i],
        key = JSON.stringify([h.name, h.value]);
      const found = this.values.get(key);
      if (found) {
        headers[i] = found.header;
        this.values.delete(key);
        this.values.set(key, found);
        continue;
      }
      added += 64 + (h.name.length + h.value.length) * 2;
      const bytes = 128 + key.length * 2;
      if (bytes > 1024 * 1024) continue;
      while (this.values.size && (this.bytes + bytes > 1024 * 1024 || this.values.size >= 4096)) {
        const first = this.values.keys().next().value!;
        this.bytes -= this.values.get(first)!.bytes;
        this.values.delete(first);
      }
      this.values.set(key, { header: Object.freeze(h), bytes });
      this.bytes += bytes;
    }
    const growth = Math.max(0, this.bytes - this.peak);
    this.peak = Math.max(this.peak, this.bytes);
    return added + growth;
  }
}
