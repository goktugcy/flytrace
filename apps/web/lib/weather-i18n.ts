import type { WeatherKind } from '@flytrace/shared';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const CONDITION_LABEL_KEYS: Record<string, string> = {
  Clear: 'weather.condition.clear',
  'Partly cloudy': 'weather.condition.partlyCloudy',
  Fog: 'weather.condition.fog',
  'Low visibility / fog': 'weather.condition.lowVisibilityFog',
  Drizzle: 'weather.condition.drizzle',
  Rain: 'weather.condition.rain',
  Showers: 'weather.condition.showers',
  'Rain showers': 'weather.condition.rainShowers',
  Snow: 'weather.condition.snow',
  'Snow showers': 'weather.condition.snowShowers',
  Thunderstorm: 'weather.condition.thunderstorm',
  'Convective storm risk': 'weather.condition.convectiveStormRisk',
  'Strong wind': 'weather.condition.strongWind',
};

const KIND_KEYS: Record<WeatherKind, string> = {
  clear: 'weather.condition.clear',
  rain: 'weather.condition.rain',
  storm: 'weather.condition.thunderstorm',
  wind: 'weather.condition.strongWind',
  snow: 'weather.condition.snow',
  fog: 'weather.condition.fog',
};

const TURBULENCE_REASON_KEYS: Record<string, string> = {
  'Very strong convective potential': 'weather.reason.veryStrongConvective',
  'Strong convective potential': 'weather.reason.strongConvective',
  'Elevated convective potential': 'weather.reason.elevatedConvective',
  'Some convective potential': 'weather.reason.someConvective',
  'Thunderstorm conditions': 'weather.reason.thunderstorm',
  'Strong modelled wind shear near flight level': 'weather.reason.strongShear',
  'Moderate modelled wind shear near flight level': 'weather.reason.moderateShear',
  'Light modelled wind shear near flight level': 'weather.reason.lightShear',
  'Strong vertical air motion in the forecast model': 'weather.reason.strongVertical',
  'Moderate vertical air motion in the forecast model': 'weather.reason.moderateVertical',
  'Vertical air motion in the forecast model': 'weather.reason.vertical',
  'Very strong wind near flight level': 'weather.reason.veryStrongFlightWind',
  'Strong wind near flight level': 'weather.reason.strongFlightWind',
};

export function translateWeatherCondition(
  t: Translate,
  condition: { kind?: unknown; label?: unknown },
): string {
  const label = typeof condition.label === 'string' ? condition.label : '';
  const labelKey = CONDITION_LABEL_KEYS[label];
  if (labelKey) return t(labelKey);

  const kind = condition.kind as WeatherKind;
  const kindKey = KIND_KEYS[kind];
  return kindKey ? t(kindKey) : label || t('map.weather');
}

export function translateWeatherSeverity(t: Translate, severity: unknown): string {
  const value = typeof severity === 'string' ? severity : 'none';
  return t(`weather.severity.${value}`);
}

export function translateTurbulenceReason(t: Translate, reason: string): string {
  const key = TURBULENCE_REASON_KEYS[reason];
  return key ? t(key) : reason;
}
