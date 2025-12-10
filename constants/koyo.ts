/**
 * 古窯（Koyo）の座標定数
 * APIとフロントで共通利用
 */
export const KOYO_COORDINATES = {
  lat: 38.14812928945047,
  lng: 140.26124686001214,
} as const;

/**
 * スポット座標の修正定数
 * Supabaseの座標が不正確な場合に使用
 * 現在は空（Supabaseで直接修正済み）
 */
export const SPOT_COORDINATE_FIXES: Record<string, { lat: number; lng: number }> = {} as const;

