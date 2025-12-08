/**
 * 県境座標テーブル
 * GoogleMap.tsxで使用する県境座標のマスター
 * 既存のprefEntryPoints.tsからデフォルトの座標を取得
 */

import { getDefaultEntryPoint } from "@/app/api/koyo/before/_constants/prefEntryPoints";
import type { PrefectureKey } from "@/app/api/koyo/before/_constants/prefEntryPoints";

export type { PrefectureKey };

/**
 * 県境座標マスター（各県のデフォルト流入地点）
 * GoogleMap.tsxでDirections APIのoriginとして使用
 */
export const PREF_ENTRY_POINTS = {
  miyagi: (() => {
    const entry = getDefaultEntryPoint("miyagi");
    return { lat: entry.lat, lng: entry.lng };
  })(),
  fukushima: (() => {
    const entry = getDefaultEntryPoint("fukushima");
    return { lat: entry.lat, lng: entry.lng };
  })(),
  akita: (() => {
    const entry = getDefaultEntryPoint("akita");
    return { lat: entry.lat, lng: entry.lng };
  })(),
  niigata: (() => {
    const entry = getDefaultEntryPoint("niigata");
    return { lat: entry.lat, lng: entry.lng };
  })(),
} as const;

/**
 * 県名から県境座標を取得する
 * @param pref 県名
 * @returns 県境座標 { lat, lng }
 */
export function getPrefBoundary(pref: PrefectureKey): { lat: number; lng: number } {
  return PREF_ENTRY_POINTS[pref];
}

