import fs from 'fs/promises';
import { IdentityRule } from './types.js';

/**
 * Resolves commit author emails and ADO identities to one canonical developer id.
 *
 * Automatic merges are limited to exact (case-insensitive) email / uniqueName matches.
 * Name-only matches are never merged automatically, because two people can share a name.
 * Those show up in possibleDuplicates() so they can be added to the identity map.
 */
export class IdentityResolver {
  private aliasToCanonical = new Map<string, string>();
  private displayNames = new Map<string, string>();
  private namesSeen = new Map<string, Set<string>>(); // normalized name -> canonical ids

  constructor(rules: IdentityRule[] = []) {
    for (const rule of rules) {
      const canonical = norm(rule.canonical);
      this.aliasToCanonical.set(canonical, canonical);
      for (const a of rule.aliases ?? []) this.aliasToCanonical.set(norm(a), canonical);
      if (rule.displayName) this.displayNames.set(canonical, rule.displayName);
    }
  }

  static async fromFile(file?: string): Promise<IdentityResolver> {
    if (!file) return new IdentityResolver();
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const rules: IdentityRule[] = Array.isArray(raw) ? raw : raw.identities ?? [];
    return new IdentityResolver(rules);
  }

  /** Resolve an email / uniqueName (and optionally a display name) to a canonical id. */
  resolve(emailOrUniqueName: string, name?: string): string {
    const key = norm(emailOrUniqueName);
    let canonical = this.aliasToCanonical.get(key);
    if (!canonical && name) canonical = this.aliasToCanonical.get(norm(name));
    canonical = canonical ?? key;
    if (name) {
      if (!this.displayNames.has(canonical)) this.displayNames.set(canonical, name);
      const n = normName(name);
      if (n) {
        if (!this.namesSeen.has(n)) this.namesSeen.set(n, new Set());
        this.namesSeen.get(n)!.add(canonical);
      }
    }
    return canonical;
  }

  displayName(canonical: string): string {
    return this.displayNames.get(canonical) ?? canonical;
  }

  /** Same display name mapped to more than one id. Candidates for the identity map. */
  possibleDuplicates(): Array<{ name: string; ids: string[] }> {
    const out: Array<{ name: string; ids: string[] }> = [];
    for (const [name, ids] of this.namesSeen) {
      if (ids.size > 1) out.push({ name, ids: [...ids].sort() });
    }
    return out;
  }

  /** True if the id (or any alias of the given value) resolves to the benchmark set. */
  matchesAny(canonical: string, candidates: string[]): boolean {
    return candidates.some((c) => this.resolve(c) === canonical);
  }
}

function norm(s: string): string {
  return (s ?? '').trim().toLowerCase();
}

function normName(s: string): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
