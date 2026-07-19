import { type Counter, type Histogram, MetricsRegistry } from '@flytrace/shared';

export interface TrackerMetrics {
  registry: MetricsRegistry;
  providerRequests: Counter;
  providerFailures: Counter;
  providerLatency: Histogram;
  observationsReceived: Counter;
  observationsAccepted: Counter;
  observationsRejected: Counter;
  staleFlights: Counter;
  signalLostFlights: Counter;
  recoveredFlights: Counter;
  endedFlights: Counter;
}

export function createTrackerMetrics(): TrackerMetrics {
  const registry = new MetricsRegistry();
  return {
    registry,
    providerRequests: registry.counter('tracker_provider_requests_total', 'Provider poll attempts'),
    providerFailures: registry.counter('tracker_provider_failures_total', 'Provider poll failures'),
    providerLatency: registry.histogram(
      'tracker_provider_latency_seconds',
      'Provider poll latency (s)',
    ),
    observationsReceived: registry.counter(
      'tracker_observations_received_total',
      'Normalized observations received by tracker',
    ),
    observationsAccepted: registry.counter(
      'tracker_observations_accepted_total',
      'Observations accepted into tracker state',
    ),
    observationsRejected: registry.counter(
      'tracker_observations_rejected_total',
      'Observations rejected before state update',
    ),
    staleFlights: registry.counter('tracker_flights_stale_total', 'Flights marked stale'),
    signalLostFlights: registry.counter(
      'tracker_flights_signal_lost_total',
      'Flights marked signal_lost',
    ),
    recoveredFlights: registry.counter('tracker_flights_recovered_total', 'Flights recovered'),
    endedFlights: registry.counter('tracker_flights_ended_total', 'Flights ended'),
  };
}
