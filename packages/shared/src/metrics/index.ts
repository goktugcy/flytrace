/**
 * Minimal Prometheus-style metrics (docs/14). Dependency-free: counters,
 * gauges, and histograms with labels, rendered in the text exposition format
 * for a `/metrics` endpoint. Swap for prom-client later behind the same shapes.
 */
type Labels = Record<string, string>;

function keyOf(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(',')}}`;
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  abstract render(): string[];
}

export class Counter extends Metric {
  private values = new Map<string, { labels: Labels; value: number }>();
  inc(labels: Labels = {}, amount = 1): void {
    const k = keyOf(labels);
    const cur = this.values.get(k);
    if (cur) cur.value += amount;
    else this.values.set(k, { labels, value: amount });
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values())
      out.push(`${this.name}${renderLabels(labels)} ${value}`);
    return out;
  }
}

export class Gauge extends Metric {
  private values = new Map<string, { labels: Labels; value: number }>();
  set(value: number, labels: Labels = {}): void {
    this.values.set(keyOf(labels), { labels, value });
  }
  add(amount: number, labels: Labels = {}): void {
    const k = keyOf(labels);
    const cur = this.values.get(k);
    this.values.set(k, { labels, value: (cur?.value ?? 0) + amount });
  }
  inc(labels: Labels = {}): void {
    this.add(1, labels);
  }
  dec(labels: Labels = {}): void {
    this.add(-1, labels);
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values())
      out.push(`${this.name}${renderLabels(labels)} ${value}`);
    return out;
  }
}

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram extends Metric {
  private series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  constructor(
    name: string,
    help: string,
    private readonly buckets: number[] = DEFAULT_BUCKETS,
  ) {
    super(name, help);
  }
  observe(value: number, labels: Labels = {}): void {
    const k = keyOf(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= (this.buckets[i] as number)) s.counts[i] = (s.counts[i] as number) + 1;
    }
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i += 1) {
        cumulative = s.counts[i] as number;
        out.push(
          `${this.name}_bucket${renderLabels({ ...s.labels, le: String(this.buckets[i]) })} ${cumulative}`,
        );
      }
      out.push(`${this.name}_bucket${renderLabels({ ...s.labels, le: '+Inf' })} ${s.count}`);
      out.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      out.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return out;
  }
}

export class MetricsRegistry {
  private metrics: Metric[] = [];
  register<T extends Metric>(metric: T): T {
    this.metrics.push(metric);
    return metric;
  }
  counter(name: string, help: string): Counter {
    return this.register(new Counter(name, help));
  }
  gauge(name: string, help: string): Gauge {
    return this.register(new Gauge(name, help));
  }
  histogram(name: string, help: string, buckets?: number[]): Histogram {
    return this.register(new Histogram(name, help, buckets));
  }
  /** Prometheus text exposition format. */
  render(): string {
    return `${this.metrics.flatMap((m) => m.render()).join('\n')}\n`;
  }
}
