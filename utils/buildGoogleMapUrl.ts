export const buildGoogleMapUrl = (spots: { lat: number; lng: number; name: string }[]) => {
  if (!spots || spots.length === 0) return "";

  // null安全性チェック：有効な座標を持つスポットのみをフィルタリング
  const validSpots = spots.filter((s) => s.lat != null && s.lng != null);

  if (validSpots.length === 0) return "";

  const origin = `${validSpots[0].lat},${validSpots[0].lng}`;
  const destination = `${validSpots[validSpots.length - 1].lat},${validSpots[validSpots.length - 1].lng}`;

  const waypoints =
    validSpots.length > 2
      ? validSpots
          .slice(1, -1)
          .map((s) => `${s.lat},${s.lng}`)
          .join("|")
      : "";

  const waypointsParam = waypoints ? `&waypoints=${waypoints}` : "";

  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${waypointsParam}&travelmode=driving`;
};

