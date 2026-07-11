/**
 * Hand-rolled Prometheus text-format (0.0.4) registry — counters and
 * histograms with a small fixed label space. No dependency, no magic;
 * exactly what /metrics needs and nothing more.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`)
    .join(',');
}

function renderLabels(labels: Labels, extra?: string): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`);
  if (extra) parts.push(extra);
  return parts.length ? `{${parts.join(',')}}` : '';
}

export class Counter {
  private readonly series = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const entry = this.series.get(key) ?? { labels, value: 0 };
    entry.value += by;
    this.series.set(key, entry);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.series.size === 0) lines.push(`${this.name} 0`);
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Histogram {
  private readonly series = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly bounds: number[] = [0.005, 0.025, 0.1, 0.25, 1, 2.5, 10, 30],
  ) {}

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    for (let i = 0; i < this.bounds.length; i++) {
      if (value <= this.bounds[i]) entry.buckets[i]++;
    }
    entry.sum += value;
    entry.count++;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, buckets, sum, count } of this.series.values()) {
      this.bounds.forEach((bound, i) => {
        lines.push(`${this.name}_bucket${renderLabels(labels, `le="${bound}"`)} ${buckets[i]}`);
      });
      lines.push(`${this.name}_bucket${renderLabels(labels, 'le="+Inf"')} ${count}`);
      lines.push(`${this.name}_sum${renderLabels(labels)} ${sum}`);
      lines.push(`${this.name}_count${renderLabels(labels)} ${count}`);
    }
    return lines.join('\n');
  }
}

export class Registry {
  private readonly metrics: Array<Counter | Histogram> = [];
  private readonly gauges: Array<{ name: string; help: string; read: () => number }> = [];

  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.metrics.push(c);
    return c;
  }

  histogram(name: string, help: string, bounds?: number[]): Histogram {
    const h = new Histogram(name, help, bounds);
    this.metrics.push(h);
    return h;
  }

  /** callback gauge, sampled at render time (cache bytes, tracked IPs, …) */
  gauge(name: string, help: string, read: () => number): void {
    this.gauges.push({ name, help, read });
  }

  render(): string {
    const parts = this.metrics.map((m) => m.render());
    for (const g of this.gauges) {
      parts.push(`# HELP ${g.name} ${g.help}\n# TYPE ${g.name} gauge\n${g.name} ${g.read()}`);
    }
    return `${parts.join('\n')}\n`;
  }
}
