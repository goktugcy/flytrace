export const OBSERVATION_REJECTION_REASONS = [
  'stale_observation',
  'duplicate_timestamp',
  'out_of_order',
  'invalid_coordinates',
  'impossible_jump',
  'provider_timeout',
  'missing_position',
  'invalid_speed',
  'lower_quality_candidate',
] as const;

export type ObservationRejectionReason = (typeof OBSERVATION_REJECTION_REASONS)[number];

export interface ProviderCandidateDebug {
  provider: string;
  selected: boolean;
  sourceTimestamp?: string;
  receivedAt?: string;
  ageMs?: number;
  qualityScore?: number;
  positionSource?: string;
  isMlat?: boolean;
  rejectionReason?: ObservationRejectionReason;
}

export interface ObservationRejectionDebug {
  at: string;
  reason: ObservationRejectionReason;
  source?: string;
  sourceTimestamp?: string;
  receivedAt?: string;
  ageMs?: number;
}
