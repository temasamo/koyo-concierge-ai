"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import BackgroundWrapper from "./koyo-lab-ui/BackgroundWrapper";
import ChatContainer from "./koyo-lab-ui/ChatContainer";
import ChatInput from "./koyo-lab-ui/ChatInput";
import { useKoyoMode, KoyoMode } from "./koyo-lab-ui/hooks/useKoyoMode";
import { useSpotStore, type OriginInfo } from "@/store/spots";
import { useMessageStore } from "@/store/messages";
import type { Msg } from "@/store/messages";
import type { RoutePlan } from "@/types/route";

// モードごとの初期メッセージ
const INITIAL_MESSAGES: Record<KoyoMode, string> = {
  before: "古窯の旅コンシェルAIでございます。旅前のご準備、お手伝いさせていただきます。まずは、どのような旅をお考えかお聞かせください。",
  stay: "古窯のフロントスタッフでございます。ご滞在中のご案内をさせていただきます。何かご不明な点やご要望がございましたら、お気軽にお申し付けください。",
  after: "古窯の旅コンシェルAIです。ご宿泊ありがとうございました。旅の思い出を大切に、何かご不明な点やお困りのことがございましたら、お気軽にお尋ねください。",
};

export default function Page() {
  const router = useRouter();
  const pathname = usePathname();
  const { mode, setMode } = useKoyoMode();
  const [input, setInput] = useState("");

  // 会話履歴をZustandストアで管理（ページ遷移後も保持される）
  const messages = useMessageStore((s) => s.getMessages(mode));
  const setMessages = useMessageStore((s) => s.setMessages);
  const addMessage = useMessageStore((s) => s.addMessage);
  const resetToInitial = useMessageStore((s) => s.resetToInitial);

  // マップ用スポット状態管理
  const setSpots = useSpotStore((s) => s.setSpots);
  const clearSpots = useSpotStore((s) => s.clearSpots);
  const spots = useSpotStore((s) => s.spots);
  const origin = useSpotStore((s) => s.origin);
  const setOrigin = useSpotStore((s) => s.setOrigin);
  const clearOrigin = useSpotStore((s) => s.clearOrigin);
  const destination = useSpotStore((s) => s.destination);
  const setDestination = useSpotStore((s) => s.setDestination);
  const clearDestination = useSpotStore((s) => s.clearDestination);
  const setRouteInfo = useSpotStore((s) => s.setRouteInfo);
  const clearRouteInfo = useSpotStore((s) => s.clearRouteInfo);
  const originInputMode = useSpotStore((s) => s.originInputMode);
  const setOriginInputMode = useSpotStore((s) => s.setOriginInputMode);
  const clearOriginInputMode = useSpotStore((s) => s.clearOriginInputMode);
  const setRoutePlan = useSpotStore((s) => s.setRoutePlan);
  const clearRoutePlan = useSpotStore((s) => s.clearRoutePlan);
  const routePlan = useSpotStore((s) => s.routePlan);

  // モードが変わったときに、そのモードの会話履歴が空なら初期メッセージを設定
  const prevModeRef = useRef<KoyoMode>(mode);
  const prevPathnameRef = useRef<string | null>(null);
  const autoResendRef = useRef(false); // 現在地取得後の自動再送信を防ぐフラグ
  
  useEffect(() => {
    const currentMessages = useMessageStore.getState().getMessages(mode);
    if (currentMessages.length === 0) {
      resetToInitial(mode, {
        role: "assistant",
        content: INITIAL_MESSAGES[mode],
      });
    }
    
    // 地図ページから戻ってきた場合は、スポットを保持する
    const isReturningFromMap = prevPathnameRef.current === "/map" && pathname === "/";
    
    // モードが実際に変わった時のみスポットをクリア（地図ページから戻った時はクリアしない）
    if (prevModeRef.current !== mode) {
      console.log(`[page.tsx] Mode changed from ${prevModeRef.current} to ${mode}, clearing spots`);
      clearSpots();
        clearOrigin();
        clearDestination();
        clearRouteInfo();
        clearOriginInputMode();
      prevModeRef.current = mode;
    } else if (isReturningFromMap) {
      console.log(`[page.tsx] Returning from map page, keeping spots (count: ${spots.length})`);
    } else {
      console.log(`[page.tsx] Mode unchanged (${mode}), keeping spots (count: ${spots.length})`);
    }
    
    // パス名を更新
    prevPathnameRef.current = pathname;
  }, [mode, pathname, clearSpots, clearOrigin, clearDestination, resetToInitial, spots.length]);

  // --- 追加：送信中の状態を管理 ---
  const [isLoading, setIsLoading] = useState(false);

  /**
   * userStateを明示的に指定してメッセージを送信する関数
   * 現在地取得後の自動再送信などで使用
   */
  const sendMessageWithUserState = async (params: {
    text: string;
    userState: {
      origin?: OriginInfo;
      destination?: OriginInfo;
      originInputMode?: "free" | "current_location" | undefined;
    };
  }) => {
    if (isLoading) return;
    
    setIsLoading(true);
    
    try {
      // ユーザーのメッセージを追加
      addMessage(mode, { role: "user", content: params.text });
      
      // 現在の messages を取得
      const currentMessages = useMessageStore.getState().getMessages(mode);
      const latestMessages = [
        ...currentMessages,
        { role: "user", content: params.text }
      ];
      
      // エンドポイントを決定（ルート編集は考慮しない）
      const apiEndpoint = `/api/koyo/${mode}`;
      
      // API コール（userStateを明示的に指定）
      const requestBody = {
        messages: latestMessages,
        userState: {
          origin: params.userState.origin,
          destination: mode === "after" ? params.userState.destination : undefined,
          originInputMode: params.userState.originInputMode,
        },
      };
      
      console.log("[page.tsx] sendMessageWithUserState - requestBody:", requestBody);
      
      const res = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      
      if (!res.ok) {
        throw new Error(`API Error: ${res.status}`);
      }
      
      const data = await res.json();
      
      // レスポンス処理（onSendと同じロジック）
      // originInputMode の扱い
      const currentOriginInputMode = useSpotStore.getState().originInputMode;
      if (data.originInputMode === "free") {
        setOriginInputMode("free");
      } else if (data.originInputMode === "current_location") {
        setOriginInputMode("current_location");
      } else if (data.originInputMode === undefined && currentOriginInputMode) {
        clearOriginInputMode();
      }
      
      // origin の扱い
      if (data.origin && data.origin.type !== null) {
        setOrigin(data.origin);
      } else {
        clearOrigin();
      }
      
      // destination の扱い（Afterモードのみ）
      if (mode === "after") {
        if (data.destination && data.destination.type !== null) {
          setDestination(data.destination);
        }
      } else {
        clearDestination();
      }
      
      // routeInfo の扱い
      if (data.routeInfo) {
        setRouteInfo(data.routeInfo);
      } else {
        clearRouteInfo();
      }
      
      // RoutePlan の更新
      if (data.spots && Array.isArray(data.spots) && data.spots.length > 0 && data.routeInfo) {
        const planId = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const modeUpper = mode.toUpperCase() as "BEFORE" | "STAY" | "AFTER";
        const newRoutePlan: RoutePlan = {
          planId,
          mode: modeUpper,
          origin: data.routeInfo.origin,
          destination: data.routeInfo.destination,
          spots: data.spots,
          constraints: {},
          bCallCount: 0,
        };
        setRoutePlan(newRoutePlan);
      }
      
      // AIの返答を追加
      if (data.reply) {
        addMessage(mode, { role: "assistant", content: data.reply });
      }
      
      // スポットを設定
      if (data.spots && Array.isArray(data.spots)) {
        setSpots(data.spots);
      }
      
    } catch (error: any) {
      console.error("[page.tsx] sendMessageWithUserState error:", error);
      addMessage(mode, {
        role: "assistant",
        content: "エラーが発生しました。もう一度お試しください。",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const onSend = async (inputMessage: string) => {
    // 現在地確定通知の場合は空文字でも許可
    if ((!inputMessage.trim() && !autoResendRef.current) || isLoading) return;

    // 送信中フラグ ON
    setIsLoading(true);
    
    // 自動再送信フラグをリセット
    if (autoResendRef.current) {
      autoResendRef.current = false;
    }

    try {
      // ① まずユーザーのメッセージを追加
      addMessage(mode, { role: "user", content: inputMessage });

      // ② 現在の messages を安全に取得（最新値を参照）
      const currentMessages = useMessageStore.getState().getMessages(mode);
      const latestMessages = [
        ...currentMessages,
        { role: "user", content: inputMessage }
      ];

      // ③ ルート編集の意図を判定（簡易キーワードベース）
      const isRouteEditIntent = (() => {
        if (!routePlan) return false; // routePlanが存在しない場合は編集不可
        const normalized = inputMessage.toLowerCase();
        const editKeywords = [
          "変更", "変え", "修正", "調整", "短く", "近く", "減らす", "削除",
          "ゆっくり", "のんびり", "余裕", "時間", "急がない",
          "食べる", "ご飯", "ランチ", "カフェ", "休憩",
        ];
        return editKeywords.some(kw => normalized.includes(kw));
      })();

      // ④ エンドポイントを決定
      const apiEndpoint = isRouteEditIntent
        ? `/api/koyo/${mode}/edit`
        : `/api/koyo/${mode}`;

      // ⑤ API コール
      // リクエスト送信時に最新の origin と destination を取得
      const currentOrigin = useSpotStore.getState().origin;
      const currentDestination = useSpotStore.getState().destination;
      const currentRoutePlan = useSpotStore.getState().routePlan;
      console.log("[page.tsx] Sending request with origin:", currentOrigin);
      console.log("[page.tsx] Sending request with destination:", currentDestination);
      console.log("[page.tsx] Is route edit intent?", isRouteEditIntent);
      console.log("[page.tsx] Current routePlan:", currentRoutePlan?.planId);
      
      const requestBody = isRouteEditIntent && currentRoutePlan
        ? {
            routePlan: currentRoutePlan,
            userMessage: inputMessage,
          }
        : {
            messages: latestMessages,
            userState: {
              origin: currentOrigin,
              destination: mode === "after" ? currentDestination : undefined,
              originInputMode: originInputMode,
            },
          };
      
      const res = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        throw new Error(`API Error: ${res.status}`);
      }

      const data = await res.json();

      // デバッグログ
      console.log("[page.tsx] API response:", data);
      console.log("[page.tsx] reply from API:", data.reply);
      console.log("[page.tsx] spots:", data.spots);
      console.log("[page.tsx] origin from API:", data.origin);
      console.log("[page.tsx] destination from API:", data.destination);
      console.log("[page.tsx] routeInfo:", data.routeInfo);
      console.log("[page.tsx] routePlan from API:", data.routePlan);
      console.log("[page.tsx] current origin in store:", origin);
      console.log("[page.tsx] current destination in store:", destination);

      // 🔽 originInputMode の扱い
      if (data.originInputMode === "free") {
        // 自由入力モードを有効化
        console.log("[page.tsx] Setting originInputMode: free");
        setOriginInputMode("free");
      } else if (data.originInputMode === "current_location") {
        // 現在地取得モードを有効化
        console.log("[page.tsx] Setting originInputMode: current_location");
        setOriginInputMode("current_location");
        // Geolocation APIを実行
        if (navigator.geolocation) {
          console.log("[page.tsx] 🔍 Geolocation requested");
          navigator.geolocation.getCurrentPosition(
            (position) => {
              console.log("[page.tsx] ✅ Geolocation success:", {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
              });
              // 現在地をoriginに設定
              const currentOrigin = {
                type: "current" as const,
                pref: null,
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                name: "現在地",
              };
              
              setOrigin(currentOrigin);
              
              // ❌ onSend("現在地を使います") は使わない
              // ✅ originを含めて明示的に送信
              console.log("[page.tsx] Sending message with current location origin");
              sendMessageWithUserState({
                text: "現在地を使用します",
                userState: {
                  origin: currentOrigin,
                  originInputMode: undefined, // 確定扱い
                },
              });
            },
            (error) => {
              console.error("[page.tsx] ❌ Geolocation failure:", error);
              // エラーメッセージを表示
              addMessage(mode, {
                role: "assistant",
                content: "現在地が取得できませんでした。位置情報の許可を確認するか、別の出発地（A〜E）を選択してください。",
              });
              // originInputModeをクリアして、通常の選択肢に戻す
              clearOriginInputMode();
            },
            {
              enableHighAccuracy: true,
              timeout: 10000,
              maximumAge: 0,
            }
          );
        } else {
          console.error("[page.tsx] ❌ Geolocation not supported");
          addMessage(mode, {
            role: "assistant",
            content: "お使いのブラウザでは位置情報が取得できません。別の出発地（A〜E）を選択してください。",
          });
          clearOriginInputMode();
        }
      } else if (data.originInputMode === undefined && (originInputMode === "free" || originInputMode === "current_location")) {
        // APIレスポンスにoriginInputModeが含まれない = 削除を意味する（origin確定時）
        console.log("[page.tsx] Clearing originInputMode (origin resolved)");
        clearOriginInputMode();
      }

      // 🔽 origin の扱いを修正
      if (data.origin && data.origin.type !== null) {
        // Pre-Checkin で決まった origin を保持
        console.log("[page.tsx] Setting origin (Pre-Checkin):", data.origin);
        setOrigin(data.origin);
        // 次のリクエストで正しい origin が送信されるように、少し待つ
        await new Promise(resolve => setTimeout(resolve, 0));
        console.log("[page.tsx] Origin set, new value:", useSpotStore.getState().origin);
      } else {
        // 通常 Before / Stay / After など → origin はクリア
        console.log("[page.tsx] Clear origin (normal mode), data.origin:", data.origin);
        clearOrigin();
      }

      // 🔽 destination の扱い（Afterモードのみ）
      if (mode === "after") {
        if (data.destination && data.destination.type !== null) {
          // After で決まった destination を保持
          console.log("[page.tsx] Setting destination (After):", data.destination);
          setDestination(data.destination);
          await new Promise(resolve => setTimeout(resolve, 0));
          console.log("[page.tsx] Destination set, new value:", useSpotStore.getState().destination);
        } else {
          // destination が未設定の場合、クリアしない（既存の値を保持）
          console.log("[page.tsx] No destination in response, keeping current:", destination);
        }
      } else {
        // After 以外のモードでは destination をクリア
        clearDestination();
      }

      // 🔽 routeInfo の扱い
      if (data.routeInfo) {
        setRouteInfo(data.routeInfo);
        console.log("[page.tsx] Set routeInfo:", data.routeInfo);
      } else {
        clearRouteInfo();
        console.log("[page.tsx] Clear routeInfo");
      }

      // 🔽 RoutePlan の更新
      if (isRouteEditIntent && data.routePlan) {
        // 編集エンドポイントからのレスポンス: routePlanを更新
        setRoutePlan(data.routePlan);
        console.log("[page.tsx] Updated RoutePlan from edit:", data.routePlan.planId);
      } else if (!isRouteEditIntent && data.spots && Array.isArray(data.spots) && data.spots.length > 0 && data.routeInfo) {
        // 初期生成: 新しいRoutePlanを作成
        const planId = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const modeUpper = mode.toUpperCase() as "BEFORE" | "STAY" | "AFTER";
        
        const routePlan: RoutePlan = {
          planId,
          mode: modeUpper,
          dayIndex: undefined, // 複数日対応は将来実装
          origin: data.routeInfo.origin,
          spots: data.spots.map((spot: any) => ({
            id: spot.id,
            name: spot.name,
            lat: spot.lat,
            lng: spot.lng,
            category: spot.category,
            city: spot.city,
            season: spot.season,
            drive_time: spot.drive_time,
            walk_time: spot.walk_time,
            stay_time: spot.stay_time,
            url: spot.url,
            tags: spot.tags,
            drive_minutes: spot.drive_minutes,
            stayMinutes: spot.stayMinutes || (spot.stay_time ? parseInt(spot.stay_time.match(/\d+/)?.[0] || "0") : null),
          })),
          destination: data.routeInfo.destination,
          constraints: {
            pace: "normal", // デフォルト値
            maxWalkMin: undefined,
          },
          bCallCount: 0, // 初期生成時は0
        };
        
        setRoutePlan(routePlan);
        console.log("[page.tsx] Created and saved RoutePlan:", routePlan.planId, "with", routePlan.spots.length, "spots");
      } else if (!isRouteEditIntent) {
        // spots または routeInfo が存在しない場合は RoutePlan をクリア
        clearRoutePlan();
        console.log("[page.tsx] Cleared RoutePlan (no spots or routeInfo)");
      }

      // ============================================================
      // スポット配列の受け取り処理
      // ============================================================
      // 【将来的な実装】
      // AI側（/api/koyo/${mode}）が /api/spots/search を呼び出して
      // スポット配列を取得し、その配列を data.spots として返す。
      // この場合、data.spots は既にSupabase形式の配列なので、
      // そのまま useSpotStore.setSpots() に渡す。
      // ============================================================
      
      // AIからスポット配列を受け取る（Supabase形式を前提）
      if (data.spots && Array.isArray(data.spots) && data.spots.length > 0) {
        // ============================================================
        // 形式の揺れチェック（Task 5: page.tsx側の修正）
        // ============================================================
        const firstSpot = data.spots[0];
        const hasSupabaseFormat = (
          Array.isArray(data.spots) &&
          firstSpot?.id &&
          (firstSpot.lat !== undefined && firstSpot.lng !== undefined) &&
          (firstSpot.city !== undefined || firstSpot.drive_minutes !== undefined)
        );

        if (hasSupabaseFormat) {
          // Supabase 格納形式（既にOK）
          console.log("[page.tsx] Received Supabase format spots:", data.spots.length);
          setSpots(data.spots);
          // returnを削除：スポット設定後もAIの返答を追加する必要がある
        } else {
          // ============================================================
          // 【暫定実装】スポット名マッチングロジック
          // ============================================================
          // TODO: 将来的に廃止予定
          // 
          // 【現段階での用途】
          // 1. 既存のチャット返答（テキストのみ）でも、一応マップを動かすための暫定手段
          // 2. どのスポット名がマッチしやすい／しにくいかを把握するためのログ出力
          // ============================================================
          
          // AI の独自 JSON → マッチングで Supabase に変換
          console.log("[page.tsx] [暫定] Converting AI spots to Supabase format via name matching...");
          console.log("[page.tsx] [暫定] AI returned spots:", data.spots.map((s: any) => s.name));
        
          // 【暫定】/api/spots/searchを呼び出してSupabase形式のデータを取得（全件取得して名前でマッチング）
        try {
          const searchRes = await fetch("/api/spots/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode,
              maxSpots: 50, // 全件取得するため大きな値を設定
            }),
          });

          if (searchRes.ok) {
            const searchData = await searchRes.json();
            const supabaseSpots = searchData.spots || [];
            console.log("[page.tsx] [暫定] Supabase spots count:", supabaseSpots.length);
            
            // 【暫定】AIが返したスポット名と一致するSupabaseスポットを抽出（部分一致も考慮）
            const aiSpotNames = data.spots.map((s: any) => s.name.trim());
            const matchedSpots: any[] = [];
            const usedSpotIds = new Set<string>(); // 重複防止
            
            console.log("[page.tsx] [暫定] AI spot names:", aiSpotNames);
            console.log("[page.tsx] [暫定] Supabase spot names:", supabaseSpots.map((s: any) => s.name));
            
            aiSpotNames.forEach((aiName: string) => {
              // 完全一致を優先
              let matched = supabaseSpots.find((spot: any) => 
                !usedSpotIds.has(spot.id) && spot.name.trim() === aiName
              );
              
              // 完全一致がない場合は部分一致を試す（より柔軟に）
              if (!matched) {
                // キーワード抽出（「上山城」「蔵王温泉」「蔵王刈田峠」など）
                const keywords = aiName.replace(/[の・]/g, "").split(/(?=[城温泉峠市町])/);
                
                matched = supabaseSpots.find((spot: any) => {
                  if (usedSpotIds.has(spot.id)) return false;
                  
                  const spotName = spot.name.replace(/[の・]/g, "");
                  
                  // キーワードが含まれているかチェック
                  return keywords.some(keyword => 
                    keyword.length >= 2 && spotName.includes(keyword)
                  ) || spotName.includes(aiName.replace(/[の・]/g, "")) || 
                     aiName.replace(/[の・]/g, "").includes(spotName);
                });
              }
              
              if (matched) {
                matchedSpots.push(matched);
                usedSpotIds.add(matched.id);
                console.log(`[page.tsx] [暫定] ✓ Matched: "${aiName}" -> "${matched.name}" (lat=${matched.lat}, lng=${matched.lng})`);
              } else {
                console.warn(`[page.tsx] [暫定] ✗ No match found for: "${aiName}"`);
              }
            });

            if (matchedSpots.length > 0) {
              console.log(`[page.tsx] [暫定] Using matched Supabase spots: ${matchedSpots.length}/${aiSpotNames.length} matched`);
              setSpots(matchedSpots);
            } else {
              console.warn("[page.tsx] [暫定] No matching Supabase spots found, clearing spots");
              clearSpots();
            }
          } else {
            console.warn("[page.tsx] [暫定] Failed to fetch Supabase spots, clearing spots");
            clearSpots();
          }
        } catch (searchError) {
          console.error("[page.tsx] [暫定] Error fetching Supabase spots:", searchError);
          // エラー時はスポットをクリア（古い座標を使わない）
          clearSpots();
        }
        }
      } else {
        // スポット配列が空または存在しない場合
        console.log("[page.tsx] No spots found, clearing");
        clearSpots();
      }

      // ④ AI の返答を追加
      if (data.reply) {
        addMessage(mode, { role: "assistant", content: data.reply });
      }
    } catch (error) {
      console.error("Chat API error:", error);

      // エラー時のメッセージ
      addMessage(mode, {
        role: "assistant",
        content: "申し訳ありません。ネットワークエラーが発生しました。しばらくしてから再度お試しください。"
      });
    } finally {
      // 送信中フラグ OFF
      setIsLoading(false);
    }

    // 入力欄をクリア
    setInput("");
  };

  return (
    <div className="relative min-h-screen">
      <BackgroundWrapper mode={mode} />

      <div className="relative z-10 flex flex-col items-center pt-8 pb-24 px-4">
        <ChatContainer mode={mode} setMode={setMode} messages={messages} isLoading={isLoading} />

        {/* 地図で見るボタン（spotsがある場合のみ表示） */}
        {spots.length > 0 && (
          <div className="mt-4 w-full max-w-[480px] px-4">
            <button
              onClick={() => router.push("/map")}
              className="w-full px-4 py-2 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 transition-colors"
            >
              地図で見る
            </button>
          </div>
        )}

        <div className="fixed left-0 right-0 bottom-0 pb-4 flex justify-center">
          <div className="w-full max-w-[480px] px-4">
            <ChatInput input={input} setInput={setInput} onSend={onSend} disabled={isLoading} />
          </div>
        </div>
      </div>
    </div>
  );
}

