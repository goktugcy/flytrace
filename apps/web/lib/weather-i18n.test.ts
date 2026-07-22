import { describe, expect, test } from 'bun:test';
import {
  translateTurbulenceReason,
  translateWeatherCondition,
  translateWeatherSeverity,
} from './weather-i18n';

const tr = (key: string) =>
  ({
    'weather.condition.thunderstorm': 'Gök gürültülü fırtına',
    'weather.condition.strongWind': 'Kuvvetli rüzgâr',
    'weather.severity.high': 'yüksek',
    'weather.reason.strongShear': 'Uçuş seviyesi yakınında güçlü modellenen rüzgâr kesmesi',
  })[key] ?? key;

describe('weather translations', () => {
  test('translates a provider condition label', () => {
    expect(translateWeatherCondition(tr, { kind: 'storm', label: 'Thunderstorm' })).toBe(
      'Gök gürültülü fırtına',
    );
  });

  test('falls back to the condition kind for an unknown provider label', () => {
    expect(translateWeatherCondition(tr, { kind: 'wind', label: 'Future wind label' })).toBe(
      'Kuvvetli rüzgâr',
    );
  });

  test('translates severity and model-generated turbulence reasons', () => {
    expect(translateWeatherSeverity(tr, 'high')).toBe('yüksek');
    expect(translateTurbulenceReason(tr, 'Strong modelled wind shear near flight level')).toBe(
      'Uçuş seviyesi yakınında güçlü modellenen rüzgâr kesmesi',
    );
  });
});
