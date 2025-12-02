import { setOptions, importLibrary } from "@googlemaps/js-api-loader";

// Google Maps APIのオプションを設定（モジュール読み込み時に一度だけ実行）
let isOptionsSet = false;

if (typeof window !== "undefined") {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (apiKey && !isOptionsSet) {
    try {
      setOptions({
        key: apiKey,
        v: "weekly",
        libraries: ["places"],
      });
      isOptionsSet = true;
      console.log("[MapLoader] Options set successfully");
    } catch (error) {
      console.warn("[MapLoader] Failed to set Google Maps API options:", error);
    }
  }
}

// Google Maps APIを読み込む関数
export async function loadGoogleMaps() {
  // クライアント側でのみ実行
  if (typeof window === "undefined") {
    throw new Error("loadGoogleMaps can only be called on the client side");
  }

  console.log("[MapLoader] Starting to load Google Maps API...");

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error("[MapLoader] NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set!");
    throw new Error("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set");
  }

  // ライブラリを読み込む
  try {
    console.log("[MapLoader] Importing maps library...");
    const { Map } = await importLibrary("maps");
    console.log("[MapLoader] Maps library imported");
    
    console.log("[MapLoader] Importing marker library...");
    const { Marker } = await importLibrary("marker");
    console.log("[MapLoader] Marker library imported");
    
    console.log("[MapLoader] Importing InfoWindow from maps...");
    const { InfoWindow } = await importLibrary("maps");
    console.log("[MapLoader] InfoWindow imported");
    
    return { Map, Marker, InfoWindow };
  } catch (error) {
    console.error("[MapLoader] Error importing libraries:", error);
    throw error;
  }
}
