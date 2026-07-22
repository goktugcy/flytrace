'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export type Locale = 'en' | 'tr';
export const LOCALES: Locale[] = ['en', 'tr'];
export const LOCALE_COOKIE = 'flytrace.locale';

// Flat, dotted message keys. Add English + Turkish in lockstep.
const en: Record<string, string> = {
  'nav.map': 'Map',
  'nav.dashboard': 'Dashboard',
  'nav.signin': 'Sign in',
  'search.placeholder': 'Search flight or callsign…',
  'search.noMatch': 'No matches for “{q}”.',
  'common.live': 'live',
  'common.retry': 'Try again',
  'common.loading': 'Loading…',
  'common.details': 'Details',
  'common.low': 'low',
  'common.high': 'high',
  'common.close': 'Close',
  'theme.toLight': 'Switch to light theme',
  'theme.toDark': 'Switch to dark theme',

  'landing.badge': 'Live flight data',
  'landing.title.pre': 'Watch the sky, ',
  'landing.title.em': 'live',
  'landing.subtitle':
    'Real aircraft, moving in real time — with takeoff, landing and descent events derived from the track, and alerts on the channel you choose.',
  'landing.cta.map': 'Open the live map',
  'landing.cta.account': 'Create account',
  'landing.counters.aircraft': 'Live aircraft',
  'landing.counters.events': 'Events today',
  'landing.features.title': 'What you get',
  'landing.f1.title': 'Real-time positions',
  'landing.f1.body':
    'Aircraft glide across the map, updated every few seconds from live ADS-B data.',
  'landing.f2.title': 'Derived events',
  'landing.f2.body':
    'Takeoff, climb, top-of-descent and landing — detected from the raw track, on a timeline.',
  'landing.f3.title': 'Watch & get pinged',
  'landing.f3.body':
    'Watch a flight and get a Web Push, Telegram, or email alert the moment something happens.',
  'landing.f4.title': 'Provider status',
  'landing.f4.body':
    'Gate changes, delays and cancellations from airline sources, layered on top of positions.',
  'landing.faq.title': 'Frequently asked',
  'landing.faq.q1': 'Where does the data come from?',
  'landing.faq.a1':
    'Live positions come from community ADS-B feeds. Flight status (gate, delay) comes from compliant public airline sources where available.',
  'landing.faq.q2': 'Is it free?',
  'landing.faq.a2':
    'Watching flights and the live map are free. Create an account to save watches and get notifications.',
  'landing.faq.q3': 'How fast are updates?',
  'landing.faq.a3':
    'Positions are pushed to your browser over WebSocket and interpolated for smooth motion.',

  'auth.welcome': 'Welcome back',
  'auth.create': 'Create your account',
  'auth.sub.signin': 'Sign in to watch flights and get alerts.',
  'auth.sub.signup': 'Start watching flights in under a minute.',
  'auth.tab.signin': 'Sign in',
  'auth.tab.signup': 'Sign up',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.password.ph': 'At least 8 characters',
  'auth.submit.signin': 'Sign in',
  'auth.submit.signup': 'Create account',
  'auth.success': 'Success — redirecting…',
  'auth.terms': 'By continuing you agree to our terms and privacy policy.',

  'map.altitude': 'Altitude',
  'map.geoAltitude': 'Geo alt',
  'map.speed': 'Speed',
  'map.heading': 'Heading',
  'map.vertical': 'V/S',
  'map.squawk': 'Squawk',
  'map.ground': 'Ground',
  'map.signal.live': 'Live',
  'map.signal.delayed': 'Delayed',
  'map.signal.stale': 'Stale',
  'map.signal.signal_lost': 'Lost',
  'map.locate': 'Show my region',
  'map.cat.light': 'Light aircraft',
  'map.cat.jet': 'Jet',
  'map.cat.heavy': 'Heavy jet',
  'map.cat.helo': 'Helicopter',
  'map.filter.all': 'All',
  'map.filter.low': '< 10k',
  'map.filter.mid': '10–30k',
  'map.filter.high': '> 30k',
  'map.filter.airline': 'Airline (e.g. THY)',
  'map.airports': 'Airports',
  'map.airports.error': 'error',
  'map.airport.code': 'Code',
  'map.airport.runways': 'Runways',
  'map.airport.scheduled': 'Scheduled',
  'map.airport.unscheduled': 'Unscheduled',
  'map.airport.website': 'Website',
  'map.airport.wiki': 'Wiki',
  'map.airspace': 'Airspace',
  'map.airspace.zoom': 'zoom',
  'map.airspace.error': 'error',
  'map.weather': 'Weather',
  'map.weather.error': 'error',
  'weather.condition.clear': 'Clear',
  'weather.condition.partlyCloudy': 'Partly cloudy',
  'weather.condition.fog': 'Fog',
  'weather.condition.lowVisibilityFog': 'Low visibility / fog',
  'weather.condition.drizzle': 'Drizzle',
  'weather.condition.rain': 'Rain',
  'weather.condition.showers': 'Showers',
  'weather.condition.rainShowers': 'Rain showers',
  'weather.condition.snow': 'Snow',
  'weather.condition.snowShowers': 'Snow showers',
  'weather.condition.thunderstorm': 'Thunderstorm',
  'weather.condition.convectiveStormRisk': 'Convective storm risk',
  'weather.condition.strongWind': 'Strong wind',
  'weather.severity.none': 'none',
  'weather.severity.low': 'low',
  'weather.severity.moderate': 'moderate',
  'weather.severity.high': 'high',
  'weather.severity.severe': 'severe',
  'weather.nearAircraft': 'Weather near aircraft',
  'weather.loading': 'Loading local weather model…',
  'weather.unavailable': 'Weather data is temporarily unavailable.',
  'weather.waitingPosition': 'Waiting for an aircraft position…',
  'weather.temperature': 'Temperature',
  'weather.precipitation': 'Precipitation',
  'weather.surfaceWind': 'Surface wind',
  'weather.windGust': 'Wind gust',
  'weather.visibility': 'Visibility',
  'weather.cape': 'CAPE',
  'weather.turbulence.estimated': 'Estimated turbulence potential',
  'weather.flightLevelWind': 'Flight-level wind',
  'weather.modelledWindShear': 'Modelled wind shear',
  'weather.pressureLevel': 'Pressure level',
  'weather.turbulence.disclaimer':
    'Model estimate from convection, vertical motion and nearby pressure-level wind shear. It is not radar, PIREP or an operational turbulence report.',
  'weather.popup.currentSample': 'Current model sample',
  'weather.popup.precipitationSuffix': 'mm precipitation',
  'weather.popup.gustSuffix': 'kt gust',
  'weather.popup.capeSuffix': 'J/kg CAPE',
  'weather.popup.risk': 'Open-Meteo · {severity} risk',
  'weather.reason.veryStrongConvective': 'Very strong convective potential',
  'weather.reason.strongConvective': 'Strong convective potential',
  'weather.reason.elevatedConvective': 'Elevated convective potential',
  'weather.reason.someConvective': 'Some convective potential',
  'weather.reason.thunderstorm': 'Thunderstorm conditions',
  'weather.reason.strongShear': 'Strong modelled wind shear near flight level',
  'weather.reason.moderateShear': 'Moderate modelled wind shear near flight level',
  'weather.reason.lightShear': 'Light modelled wind shear near flight level',
  'weather.reason.strongVertical': 'Strong vertical air motion in the forecast model',
  'weather.reason.moderateVertical': 'Moderate vertical air motion in the forecast model',
  'weather.reason.vertical': 'Vertical air motion in the forecast model',
  'weather.reason.veryStrongFlightWind': 'Very strong wind near flight level',
  'weather.reason.strongFlightWind': 'Strong wind near flight level',
  'map.webglTitle': 'The live map can’t be displayed',
  'map.webglBody':
    'This map needs WebGL, which your browser or GPU has turned off. Enable hardware acceleration (or WebGL) and reload — the rest of FlyTrace works without it.',

  'dash.title': 'Dashboard',
  'dash.subtitle': 'Your watched flights, alerts and channels.',
  'dash.settings': 'Notification settings',
  'dash.liveMap': 'Live map',
  'dash.watching': 'Watching',
  'dash.notifications': 'Notifications',
  'dash.channels': 'Channels',
  'dash.favorites': 'Favorites',
  'dash.signinTitle': 'Sign in to see your dashboard',
  'dash.signinBody': 'Watched flights, notifications and connected channels live here.',
  'dash.empty.watch': 'No watched flights yet. Open a flight and tap Watch.',
  'dash.empty.notif': 'No notifications yet.',
  'dash.empty.channels': 'No channels connected.',
  'dash.recentNotif': 'Recent notifications',
};

const tr: Record<string, string> = {
  'nav.map': 'Harita',
  'nav.dashboard': 'Panel',
  'nav.signin': 'Giriş yap',
  'search.placeholder': 'Uçuş veya çağrı kodu ara…',
  'search.noMatch': '“{q}” için sonuç yok.',
  'common.live': 'canlı',
  'common.retry': 'Tekrar dene',
  'common.loading': 'Yükleniyor…',
  'common.details': 'Detay',
  'common.low': 'alçak',
  'common.high': 'yüksek',
  'common.close': 'Kapat',
  'theme.toLight': 'Açık temaya geç',
  'theme.toDark': 'Koyu temaya geç',

  'landing.badge': 'Canlı uçuş verisi',
  'landing.title.pre': 'Gökyüzünü ',
  'landing.title.em': 'canlı',
  'landing.subtitle':
    'Gerçek uçaklar, gerçek zamanlı — kalkış, iniş ve alçalma olayları izden türetilir ve seçtiğin kanaldan bildirim alırsın.',
  'landing.cta.map': 'Canlı haritayı aç',
  'landing.cta.account': 'Hesap oluştur',
  'landing.counters.aircraft': 'Canlı uçak',
  'landing.counters.events': 'Bugünkü olaylar',
  'landing.features.title': 'Neler sunuyoruz',
  'landing.f1.title': 'Gerçek zamanlı konumlar',
  'landing.f1.body':
    'Uçaklar haritada süzülür, birkaç saniyede bir canlı ADS-B verisinden güncellenir.',
  'landing.f2.title': 'Türetilmiş olaylar',
  'landing.f2.body':
    'Kalkış, tırmanış, alçalma başı ve iniş — ham izden algılanıp zaman çizelgesine işlenir.',
  'landing.f3.title': 'İzle & haberdar ol',
  'landing.f3.body':
    'Bir uçuşu izle; olay olduğu anda Web Push, Telegram veya e-posta bildirimi al.',
  'landing.f4.title': 'Sağlayıcı durumu',
  'landing.f4.body':
    'Havayolu kaynaklarından kapı değişikliği, gecikme ve iptaller — konumların üzerine eklenir.',
  'landing.faq.title': 'Sık sorulanlar',
  'landing.faq.q1': 'Veri nereden geliyor?',
  'landing.faq.a1':
    'Canlı konumlar topluluk ADS-B beslemelerinden gelir. Uçuş durumu (kapı, gecikme) uygun olduğunda uyumlu resmi havayolu kaynaklarından alınır.',
  'landing.faq.q2': 'Ücretsiz mi?',
  'landing.faq.a2':
    'Uçuş izleme ve canlı harita ücretsiz. İzlemeleri kaydetmek ve bildirim almak için hesap oluştur.',
  'landing.faq.q3': 'Güncellemeler ne kadar hızlı?',
  'landing.faq.a3':
    'Konumlar tarayıcına WebSocket üzerinden iletilir ve pürüzsüz hareket için interpolasyon yapılır.',

  'auth.welcome': 'Tekrar hoş geldin',
  'auth.create': 'Hesabını oluştur',
  'auth.sub.signin': 'Uçuş izlemek ve bildirim almak için giriş yap.',
  'auth.sub.signup': 'Bir dakikadan kısa sürede uçuş izlemeye başla.',
  'auth.tab.signin': 'Giriş yap',
  'auth.tab.signup': 'Kayıt ol',
  'auth.email': 'E-posta',
  'auth.password': 'Şifre',
  'auth.password.ph': 'En az 8 karakter',
  'auth.submit.signin': 'Giriş yap',
  'auth.submit.signup': 'Hesap oluştur',
  'auth.success': 'Başarılı — yönlendiriliyor…',
  'auth.terms': 'Devam ederek şartları ve gizlilik politikasını kabul etmiş olursun.',

  'map.altitude': 'İrtifa',
  'map.geoAltitude': 'Geo irtifa',
  'map.speed': 'Hız',
  'map.heading': 'Yön',
  'map.vertical': 'Dikey',
  'map.squawk': 'Squawk',
  'map.ground': 'Yerde',
  'map.signal.live': 'Canlı',
  'map.signal.delayed': 'Gecikmeli',
  'map.signal.stale': 'Eski',
  'map.signal.signal_lost': 'Sinyal yok',
  'map.locate': 'Bölgemi göster',
  'map.cat.light': 'Hafif uçak',
  'map.cat.jet': 'Jet',
  'map.cat.heavy': 'Ağır jet',
  'map.cat.helo': 'Helikopter',
  'map.filter.all': 'Tümü',
  'map.filter.low': '< 10k',
  'map.filter.mid': '10–30k',
  'map.filter.high': '> 30k',
  'map.filter.airline': 'Havayolu (örn. THY)',
  'map.airports': 'Havalimanları',
  'map.airports.error': 'hata',
  'map.airport.code': 'Kod',
  'map.airport.runways': 'Pist',
  'map.airport.scheduled': 'Tarifeli',
  'map.airport.unscheduled': 'Tarifesiz',
  'map.airport.website': 'Web sitesi',
  'map.airport.wiki': 'Wiki',
  'map.airspace': 'Hava sahası',
  'map.airspace.zoom': 'zoom',
  'map.airspace.error': 'hata',
  'map.weather': 'Hava',
  'map.weather.error': 'hata',
  'weather.condition.clear': 'Açık',
  'weather.condition.partlyCloudy': 'Parçalı bulutlu',
  'weather.condition.fog': 'Sis',
  'weather.condition.lowVisibilityFog': 'Düşük görüş / sis',
  'weather.condition.drizzle': 'Çiseleme',
  'weather.condition.rain': 'Yağmur',
  'weather.condition.showers': 'Sağanak',
  'weather.condition.rainShowers': 'Yağmur sağanağı',
  'weather.condition.snow': 'Kar',
  'weather.condition.snowShowers': 'Kar sağanağı',
  'weather.condition.thunderstorm': 'Gök gürültülü fırtına',
  'weather.condition.convectiveStormRisk': 'Konvektif fırtına riski',
  'weather.condition.strongWind': 'Kuvvetli rüzgâr',
  'weather.severity.none': 'yok',
  'weather.severity.low': 'düşük',
  'weather.severity.moderate': 'orta',
  'weather.severity.high': 'yüksek',
  'weather.severity.severe': 'şiddetli',
  'weather.nearAircraft': 'Uçak çevresindeki hava durumu',
  'weather.loading': 'Yerel hava modeli yükleniyor…',
  'weather.unavailable': 'Hava durumu verisi geçici olarak kullanılamıyor.',
  'weather.waitingPosition': 'Uçak konumu bekleniyor…',
  'weather.temperature': 'Sıcaklık',
  'weather.precipitation': 'Yağış',
  'weather.surfaceWind': 'Yüzey rüzgârı',
  'weather.windGust': 'Rüzgâr hamlesi',
  'weather.visibility': 'Görüş',
  'weather.cape': 'CAPE',
  'weather.turbulence.estimated': 'Tahmini türbülans potansiyeli',
  'weather.flightLevelWind': 'Uçuş seviyesi rüzgârı',
  'weather.modelledWindShear': 'Modellenen rüzgâr kesmesi',
  'weather.pressureLevel': 'Basınç seviyesi',
  'weather.turbulence.disclaimer':
    'Konveksiyon, dikey hareket ve yakın basınç seviyelerindeki rüzgâr kesmesinden üretilen model tahminidir. Radar, PIREP veya operasyonel türbülans raporu değildir.',
  'weather.popup.currentSample': 'Güncel model örneği',
  'weather.popup.precipitationSuffix': 'mm yağış',
  'weather.popup.gustSuffix': 'kt hamle',
  'weather.popup.capeSuffix': 'J/kg CAPE',
  'weather.popup.risk': 'Open-Meteo · {severity} risk',
  'weather.reason.veryStrongConvective': 'Çok güçlü konvektif potansiyel',
  'weather.reason.strongConvective': 'Güçlü konvektif potansiyel',
  'weather.reason.elevatedConvective': 'Yüksek konvektif potansiyel',
  'weather.reason.someConvective': 'Bir miktar konvektif potansiyel',
  'weather.reason.thunderstorm': 'Gök gürültülü fırtına koşulları',
  'weather.reason.strongShear': 'Uçuş seviyesi yakınında güçlü modellenen rüzgâr kesmesi',
  'weather.reason.moderateShear': 'Uçuş seviyesi yakınında orta modellenen rüzgâr kesmesi',
  'weather.reason.lightShear': 'Uçuş seviyesi yakınında hafif modellenen rüzgâr kesmesi',
  'weather.reason.strongVertical': 'Tahmin modelinde güçlü dikey hava hareketi',
  'weather.reason.moderateVertical': 'Tahmin modelinde orta düzey dikey hava hareketi',
  'weather.reason.vertical': 'Tahmin modelinde dikey hava hareketi',
  'weather.reason.veryStrongFlightWind': 'Uçuş seviyesi yakınında çok güçlü rüzgâr',
  'weather.reason.strongFlightWind': 'Uçuş seviyesi yakınında güçlü rüzgâr',
  'map.webglTitle': 'Canlı harita gösterilemiyor',
  'map.webglBody':
    'Bu harita WebGL gerektiriyor; tarayıcın veya GPU’n kapatmış. Donanım hızlandırmayı (veya WebGL’i) açıp yeniden yükle — FlyTrace’in geri kalanı bunsuz da çalışır.',

  'dash.title': 'Panel',
  'dash.subtitle': 'İzlediğin uçuşlar, uyarılar ve kanallar.',
  'dash.settings': 'Bildirim ayarları',
  'dash.liveMap': 'Canlı harita',
  'dash.watching': 'İzlenen',
  'dash.notifications': 'Bildirimler',
  'dash.channels': 'Kanallar',
  'dash.favorites': 'Favoriler',
  'dash.signinTitle': 'Panelini görmek için giriş yap',
  'dash.signinBody': 'İzlenen uçuşlar, bildirimler ve bağlı kanallar burada.',
  'dash.empty.watch': 'Henüz izlenen uçuş yok. Bir uçuşu açıp İzle’ye dokun.',
  'dash.empty.notif': 'Henüz bildirim yok.',
  'dash.empty.channels': 'Bağlı kanal yok.',
  'dash.recentNotif': 'Son bildirimler',
};

const MESSAGES: Record<Locale, Record<string, string>> = { en, tr };

interface I18nValue {
  locale: Locale;
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.cookie = `${LOCALE_COOKIE}=${l};path=/;max-age=31536000;samesite=lax`;
    document.documentElement.lang = l;
  }, []);

  const value = useMemo<I18nValue>(() => {
    const dict = MESSAGES[locale];
    const t = (key: string, vars?: Record<string, string | number>) => {
      let s = dict[key] ?? MESSAGES.en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
      return s;
    };
    return { locale, t, setLocale };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}

/** Convenience: just the translate function. */
export function useT(): I18nValue['t'] {
  return useI18n().t;
}
