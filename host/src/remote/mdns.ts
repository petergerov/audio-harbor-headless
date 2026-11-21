import os from 'node:os';
import { Bonjour, type Service } from 'bonjour-service';

type MdnsRecord = { name: string; type: string; ttl?: number; data: unknown };
type MdnsResponse = { answers?: MdnsRecord[]; additionals?: MdnsRecord[] };
type MdnsQuery = { questions?: Array<{ name: string; type: string }> };
type MulticastDns = {
  query(query: MdnsQuery): void;
  respond(response: MdnsResponse): void;
  on(event: 'response', listener: (response: MdnsResponse) => void): void;
  on(event: 'query', listener: (query: MdnsQuery) => void): void;
  removeListener(event: 'response', listener: (response: MdnsResponse) => void): void;
};

/** How long another device has to answer before a name counts as free. */
const PROBE_MS = 1000;
const ADDRESS_CHECK_MS = 30_000;

/** The addresses the A records carry (the filter bonjour-service uses). */
function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo =>
      Boolean(a && a.family === 'IPv4' && !a.internal && a.mac !== '00:00:00:00:00:00')
    )
    .map((a) => a.address)
    .sort();
}

/** A DNS label from a configured name: "Audio Harbor" → "audio-harbor". */
function dnsLabel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.local\.?$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/**
 * This host on the LAN over mDNS / Bonjour: one responder for its `.local` name(s) and for the
 * services it offers. Records follow address changes, and leave with a goodbye on close.
 */
export class Mdns {
  /** The primary `.local` name this host answers to, once claimed. */
  hostname: string | null = null;
  /** Extra `.local` names that resolve to the same addresses. */
  aliases: string[] = [];
  /** The primary name asked for — differs from `hostname` when another device had it. */
  wanted: string | null = null;

  private readonly bonjour = new Bonjour();
  private readonly services: Service[] = [];
  private addresses = lanAddresses().join(',');
  private readonly watcher: NodeJS.Timeout;
  private answering = false;

  constructor() {
    this.watcher = setInterval(() => this.followAddresses(), ADDRESS_CHECK_MS);
    this.watcher.unref();
  }

  /**
   * Claims `<name>.local`, or `<name>-2.local`… when another device answers to it.
   * Null when the name is empty or every candidate is taken.
   */
  async claim(name: string): Promise<string | null> {
    const label = dnsLabel(name);
    if (!label) return null;
    this.wanted = `${label}.local`;
    for (let n = 1; n <= 9; n++) {
      const candidate = `${n === 1 ? label : `${label}-${n}`}.local`;
      if (!(await this.answeredElsewhere(candidate))) {
        this.hostname = candidate;
        this.startAnswering();
        return candidate;
      }
    }
    return null;
  }

  /**
   * Claims an extra `.local` name pointing at this host (no `-2` fallback — skip if taken).
   * Call after `claim()` so AAAA NSEC / A answers cover every name.
   */
  async claimAlias(name: string): Promise<string | null> {
    const label = dnsLabel(name);
    if (!label) return null;
    const candidate = `${label}.local`;
    if (candidate === this.hostname) return candidate;
    if (this.aliases.includes(candidate)) return candidate;
    if (await this.answeredElsewhere(candidate)) return null;
    this.aliases.push(candidate);
    this.startAnswering();
    this.announceAlias(candidate);
    return candidate;
  }

  /**
   * Announces a service on this host. `probe: false` when the service also carries the
   * host name's address records — those must not vanish over a clash of service names.
   */
  publish(options: { name: string; type: string; port: number; txt?: Record<string, string>; probe?: boolean }): void {
    this.services.push(
      // The servers listen on IPv4 only; AAAA records would send clients nowhere first.
      this.bonjour.publish({ ...options, host: this.hostname ?? undefined, disableIPv6: true })
    );
  }

  /** Says goodbye, so the name and the services disappear at once. */
  close(): Promise<void> {
    clearInterval(this.watcher);
    return new Promise((resolve) => {
      this.bonjour.unpublishAll(() => {
        this.bonjour.destroy();
        resolve();
      });
    });
  }

  private get socket(): MulticastDns | null {
    return (this.bonjour as unknown as { server?: { mdns?: MulticastDns } }).server?.mdns ?? null;
  }

  private names(): string[] {
    return [this.hostname, ...this.aliases].filter((n): n is string => Boolean(n));
  }

  /**
   * Answer A / AAAA for every claimed name. AAAA gets an NSEC that says A only
   * (RFC 6762 §6.1). Alias A records are ours; the primary's A records also come from
   * the published service.
   */
  private startAnswering(): void {
    if (this.answering) return;
    const mdns = this.socket;
    if (!mdns) return;
    this.answering = true;
    mdns.on('query', (query) => {
      const known = new Set(this.names().map((n) => n.toLowerCase()));
      const addrs = lanAddresses();
      for (const q of query.questions ?? []) {
        const qn = q.name.toLowerCase();
        if (!known.has(qn)) continue;
        if (q.type === 'AAAA' || q.type === 'ANY') {
          mdns.respond({
            answers: [{ name: q.name, type: 'NSEC', ttl: 120, data: { nextDomain: q.name, rrtypes: ['A'] } }],
          });
        }
        if ((q.type === 'A' || q.type === 'ANY') && this.aliases.some((a) => a.toLowerCase() === qn)) {
          mdns.respond({
            answers: addrs.map((data) => ({ name: q.name, type: 'A', ttl: 120, data })),
          });
        }
      }
    });
  }

  private announceAlias(name: string): void {
    const mdns = this.socket;
    if (!mdns) return;
    const answers = lanAddresses().map((data) => ({ name, type: 'A', ttl: 120, data }));
    if (answers.length) mdns.respond({ answers });
  }

  private answeredElsewhere(name: string): Promise<boolean> {
    const mdns = this.socket;
    if (!mdns) return Promise.resolve(false);
    const own = new Set(
      Object.values(os.networkInterfaces())
        .flat()
        .map((a) => a?.address)
    );
    return new Promise((resolve) => {
      let taken = false;
      const onResponse = (response: MdnsResponse) => {
        for (const r of [...(response.answers ?? []), ...(response.additionals ?? [])]) {
          if ((r.type === 'A' || r.type === 'AAAA') && r.name.toLowerCase() === name && !own.has(String(r.data))) {
            taken = true;
          }
        }
      };
      const ask = () =>
        mdns.query({
          questions: [
            { name, type: 'A' },
            { name, type: 'AAAA' },
          ],
        });
      mdns.on('response', onResponse);
      ask();
      setTimeout(ask, PROBE_MS / 4).unref();
      setTimeout(ask, PROBE_MS / 2).unref();
      setTimeout(() => {
        mdns.removeListener('response', onResponse);
        resolve(taken);
      }, PROBE_MS);
    });
  }

  /** A new address (DHCP, Wi‑Fi rejoin): announce the records again with it. */
  private followAddresses(): void {
    const now = lanAddresses().join(',');
    if (now === this.addresses) return;
    this.addresses = now;
    for (const service of this.services) {
      service.stop(() => service.start());
    }
    for (const alias of this.aliases) this.announceAlias(alias);
  }
}
