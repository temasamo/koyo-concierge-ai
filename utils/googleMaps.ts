/**
 * Google Maps URL を構築する utility 関数
 * Googleマップアプリで開くためのURLを生成
 */

export interface RoutePoint {
  lat: number;
  lng: number;
}

/**
 * Google Maps URL を構築
 * @param origin 出発地の座標
 * @param waypoints 中継地点の座標配列（空配列可）
 * @param destination 到着地の座標
 * @returns Google Maps URL
 */
export function buildGoogleMapsUrl(
  origin: RoutePoint,
  waypoints: RoutePoint[] = [],
  destination: RoutePoint
): string {
  const base = "https://www.google.com/maps/dir/?api=1";

  const originParam = `origin=${origin.lat},${origin.lng}`;
  const destinationParam = `destination=${destination.lat},${destination.lng}`;

  const waypointsParam =
    waypoints.length > 0
      ? `&waypoints=${waypoints
          .map((p) => `${p.lat},${p.lng}`)
          .join("|")}`
      : "";

  const mode = "&travelmode=driving";

  return `${base}&${originParam}&${destinationParam}${waypointsParam}${mode}`;
}

