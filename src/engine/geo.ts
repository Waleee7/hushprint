// Offline geography: distance maths + a small gazetteer so we can say "12 km from Atlanta" with no network.
import { LAND_H, LAND_ROWS, LAND_TOP_LAT, LAND_W } from './landmask.ts';

export interface LatLon { lat: number; lon: number }

export const haversineKm = (a: LatLon, b: LatLon): number => {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const formatCoord = ({ lat, lon }: LatLon): string =>
  `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`;

export const formatDistance = (km: number): string =>
  km < 1 ? `${Math.max(10, Math.round(km * 1000 / 10) * 10)} m` : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString('en-US')} km`;

type City = [name: string, lat: number, lon: number];
export const CITIES: City[] = [
  ['Atlanta', 33.749, -84.388], ['New York', 40.713, -74.006], ['Los Angeles', 34.052, -118.244], ['Chicago', 41.878, -87.63],
  ['Houston', 29.76, -95.37], ['Miami', 25.762, -80.192], ['Dallas', 32.777, -96.797], ['Washington DC', 38.907, -77.037],
  ['Boston', 42.36, -71.059], ['Seattle', 47.606, -122.332], ['San Francisco', 37.775, -122.419], ['Denver', 39.739, -104.99],
  ['Phoenix', 33.448, -112.074], ['Philadelphia', 39.953, -75.165], ['Charlotte', 35.227, -80.843], ['Nashville', 36.163, -86.782],
  ['New Orleans', 29.951, -90.072], ['Orlando', 28.538, -81.379], ['Birmingham AL', 33.52, -86.803], ['Tuscaloosa', 33.21, -87.569],
  ['Detroit', 42.331, -83.046], ['Minneapolis', 44.978, -93.265], ['Las Vegas', 36.17, -115.14], ['Honolulu', 21.307, -157.858],
  ['Anchorage', 61.218, -149.9], ['Toronto', 43.653, -79.383], ['Vancouver', 49.283, -123.121], ['Montreal', 45.502, -73.567],
  ['Mexico City', 19.433, -99.133], ['San Juan', 18.466, -66.106], ['Philipsburg (St Maarten)', 18.026, -63.046], ['Havana', 23.113, -82.367],
  ['Bogota', 4.711, -74.072], ['Lima', -12.046, -77.043], ['Sao Paulo', -23.55, -46.633], ['Rio de Janeiro', -22.907, -43.173],
  ['Buenos Aires', -34.604, -58.382], ['Santiago', -33.449, -70.669], ['London', 51.507, -0.128], ['Paris', 48.857, 2.352],
  ['Madrid', 40.417, -3.704], ['Lisbon', 38.722, -9.139], ['Rome', 41.903, 12.496], ['Berlin', 52.52, 13.405], ['Amsterdam', 52.368, 4.904],
  ['Dublin', 53.35, -6.26], ['Stockholm', 59.329, 18.069], ['Moscow', 55.756, 37.617], ['Istanbul', 41.008, 28.978], ['Athens', 37.984, 23.728],
  ['Cairo', 30.044, 31.236], ['Lagos', 6.524, 3.379], ['Accra', 5.604, -0.187], ['Nairobi', -1.292, 36.822], ['Johannesburg', -26.204, 28.047],
  ['Cape Town', -33.925, 18.424], ['Casablanca', 33.573, -7.589], ['Dubai', 25.205, 55.271], ['Tel Aviv', 32.085, 34.782], ['Mumbai', 19.076, 72.878],
  ['Delhi', 28.614, 77.209], ['Bangkok', 13.756, 100.502], ['Singapore', 1.352, 103.82], ['Jakarta', -6.209, 106.846], ['Manila', 14.6, 120.984],
  ['Hong Kong', 22.32, 114.17], ['Shanghai', 31.23, 121.474], ['Beijing', 39.904, 116.407], ['Seoul', 37.567, 126.978], ['Tokyo', 35.676, 139.65],
  ['Sydney', -33.869, 151.209], ['Melbourne', -37.814, 144.963], ['Auckland', -36.848, 174.763], ['Reykjavik', 64.147, -21.943],
];

export const nearestCity = (p: LatLon, n = 1): { name: string; km: number; lat: number; lon: number }[] =>
  CITIES.map(([name, lat, lon]) => ({ name, lat, lon, km: haversineKm(p, { lat, lon }) }))
    .sort((a, b) => a.km - b.km).slice(0, n);

/** How precisely coordinates pin you down, in words. */
export const precisionWords = (accuracyM?: number): string =>
  accuracyM === undefined ? 'typically accurate to a few metres' : `accurate to about ${Math.round(accuracyM)} m`;

let grid: boolean[][] | undefined;
export const landGrid = (): boolean[][] => {
  if (!grid) {
    grid = LAND_ROWS.map((hex) => [...hex].flatMap((h) => parseInt(h, 16).toString(2).padStart(4, '0').split('').map((b) => b === '1')));
  }
  return grid;
};
export const LAND_DIMS = { w: LAND_W, h: LAND_H, topLat: LAND_TOP_LAT };

/** Equirectangular projection into landGrid cell space (fractional). */
export const project = ({ lat, lon }: LatLon) => ({ x: (lon + 180) / 2, y: (LAND_TOP_LAT - lat) / 2 });
