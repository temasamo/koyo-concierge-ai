"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import BackgroundWrapper from "./koyo-lab-ui/BackgroundWrapper";
import ChatContainer from "./koyo-lab-ui/ChatContainer";
import ChatInput from "./koyo-lab-ui/ChatInput";
import { useKoyoMode, KoyoMode } from "./koyo-lab-ui/hooks/useKoyoMode";
import { useSpotStore, type OriginInfo, type Spot } from "@/store/spots";
import { useMessageStore } from "@/store/messages";
import type { Msg } from "@/store/messages";
import type { RoutePlan } from "@/types/route";
import { KOYO_COORDINATES } from "@/constants/koyo";
import { getPrefBoundary } from "@/store/prefBoundaries";
import type { PrefectureKey } from "@/app/api/koyo/before/_constants/prefEntryPoints";

// モードごとの初期メッセージ
const INITIAL_MESSAGES: Record<KoyoMode, string> = {
  before: "古窯の旅コンシェルAIでございます。チェックイン前のご準備、お手伝いさせていただきます。まずは、どのような旅をお考えかお聞かせください。",
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
  const setDraft = useSpotStore((s) => s.setDraft);
  const clearRouteInfo = useSpotStore((s) => s.clearRouteInfo);
  const routeInfo = useSpotStore((s) => s.routeInfo);
  const originInputMode = useSpotStore((s) => s.originInputMode);
  const setOriginInputMode = useSpotStore((s) => s.setOriginInputMode);
  const clearOriginInputMode = useSpotStore((s) => s.clearOriginInputMode);
  const setRoutePlan = useSpotStore((s) => s.setRoutePlan);
  const clearRoutePlan = useSpotStore((s) => s.clearRoutePlan);
  const routePlan = useSpotStore((s) => s.routePlan);
  const selectedSpotId = useSpotStore((s) => s.selectedSpotId);
  const selectedSpotSource = useSpotStore((s) => s.selectedSpotSource);
  const lastSelectionSentId = useSpotStore((s) => s.lastSelectionSentId);
  const setLastSelectionSentId = useSpotStore((s) => s.setLastSelectionSentId);
  const setSelectedSpot = useSpotStore((s) => s.setSelectedSpot);
  // Phase2-2: 候補スポット管理
  const setOptionalSpots = useSpotStore((s) => s.setOptionalSpots);
  const optionalSpots = useSpotStore((s) => s.optionalSpots);
  // Phase2-2.5: ルート関連stateの一括更新
  const applyRouteUpdate = useSpotStore((s) => s.applyRouteUpdate);

  // モードが変わったときに、そのモードの会話履歴が空なら初期メッセージを設定
  const prevModeRef = useRef<KoyoMode>(mode);
  const prevPathnameRef = useRef<string | null>(null);
  const autoResendRef = useRef(false); // 現在地取得後の自動再送信を防ぐフラグ
  const autoSendLastSentIdRef = useRef<string | null>(null);
  const autoSendInFlightRef = useRef(false);
  
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
  const isLoadingRef = useRef(false);
  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  /**
   * userStateを明示的に指定してメッセージを送信する関数
   * 現在地取得後の自動再送信などで使用
   */
  const sendMessageWithUserState = useCallback(async (params: {
    text: string;
    userState: {
      origin?: OriginInfo;
      destination?: OriginInfo;
      originInputMode?: "free" | "current_location" | undefined;
      selectedSpotId?: string | null;
      selectedSpotSource?: "map" | "chat" | null;
    };
  }) => {
    if (isLoadingRef.current) return;
    
    setIsLoading(true);
    
    try {
      // ユーザーのメッセージを追加
      addMessage(mode, { role: "user", content: params.text });
      console.log("[Chat] add user message", { text: params.text });
      
      // 現在の messages を取得
      const currentMessages = useMessageStore.getState().getMessages(mode);
      const latestMessages = [
        ...currentMessages,
        { role: "user", content: params.text }
      ];
      
      // エンドポイントを決定（ルート編集は考慮しない）
      const apiEndpoint = `/api/koyo/${mode}`;
      
      // payload構築直前に最新の状態を取得
      const store = useSpotStore.getState();
      const requestBody = {
        messages: latestMessages,
        userState: {
          origin: params.userState.origin,
          destination: mode === "after" ? params.userState.destination : undefined,
          originInputMode: params.userState.originInputMode,
          tripId: store.tripId,
          selectedSpotId: params.userState.selectedSpotId ?? store.selectedSpotId,
          selectedSpotSource: params.userState.selectedSpotSource ?? store.selectedSpotSource,
          // Afterモードの場合、ルート状態をuserStateに追加
          // 重要: routePlan.spotsを優先（Places API由来のスポットも含む）
          ...(mode === "after"
            ? {
                routePlanId: store.routePlan?.planId ?? null,
                spots: (store.routePlan?.spots as Spot[]) || store.spots || [],
                routeInfo: store.routeInfo ?? null,
              }
            : {}),
          ...(mode === "after"
            ? (() => {
                // payload構築直前に最新の状態を取得
                const currentSpots = store.spots; // 確定済み経由地（最新の値を取得）
                const currentRouteInfo = store.routeInfo;
                const currentOptionalSpots = store.optionalSpots;
                
                // Phase2-2完了後（確定済み経由地がある場合）は phase: "after:phase2_2_done" を送る
                const phase = currentSpots.length > 0 ? "after:phase2_2_done" : "after:phase2_2_waiting_selection";
                
                // destination座標を確定（currentDestinationから優先、なければrouteInfoから）
                let destinationCoords: { lat: number; lng: number } | undefined;
                if (mode === "after" && params.userState.destination) {
                  const dest = params.userState.destination;
                  if (dest.type === "pref-boundary" && dest.pref) {
                    // pref-boundaryの場合は境界座標を取得
                    const prefBoundary = getPrefBoundary(dest.pref as PrefectureKey);
                    if (prefBoundary) {
                      destinationCoords = prefBoundary;
                    }
                  } else if (dest.lat && dest.lng) {
                    destinationCoords = {
                      lat: dest.lat,
                      lng: dest.lng,
                    };
                  }
                }
                // currentDestinationから取得できない場合はrouteInfoから補助的に取得
                if (!destinationCoords && currentRouteInfo?.destination) {
                  destinationCoords = currentRouteInfo.destination;
                }
                
                return {
                  context: {
                    after: {
                      phase,
                      optionalSpots: currentOptionalSpots,
                      spots: currentSpots.length > 0 ? currentSpots : undefined, // 必ず最新の値を使用
                      // routeInfoは巨大なので、再生成に必要な最小情報だけ送る
                      routeInfoKey: "direct", // 直行ルートを意味するフラグ
                      origin: currentRouteInfo?.origin || KOYO_COORDINATES,
                      destination: destinationCoords, // 確定した座標を送る
                    },
                  },
                };
              })()
            : {}),
          ...(mode === "before"
            ? (() => {
                const currentOptionalSpots = store.optionalSpots;
                const phase =
                  currentOptionalSpots.length > 0
                    ? "before:phase2_2_waiting_selection"
                    : "before:phase2_1";
                return {
                  context: {
                    before: {
                      phase,
                      optionalSpots: currentOptionalSpots,
                      routeInfoKey: "direct",
                      origin: params.userState.origin,
                    },
                  },
                };
              })()
            : {}),
        },
      };
      
      console.log("[page.tsx] sendMessageWithUserState - requestBody:", requestBody);
      console.log("[API] request", { endpoint: apiEndpoint, payload: params });
      
      if (mode === "stay") {
        console.log("[Chat] sending userState", {
          tripId: store.tripId,
          selectedSpotId: store.selectedSpotId,
          selectedSpotSource: store.selectedSpotSource,
          mode,
        });
        console.log("[page.tsx] onSend stay requestBody:", requestBody);
      }
      if (mode === "stay") {
        console.log("[Chat] sending userState", {
          tripId: store.tripId,
          selectedSpotId: store.selectedSpotId,
          selectedSpotSource: store.selectedSpotSource,
          mode,
        });
      }
      const res = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      
      if (!res.ok) {
        throw new Error(`API Error: ${res.status}`);
      }
      
      const data = await res.json();
      console.log("[API] response", {
        ok: res.ok,
        status: res.status,
        reply: data?.reply,
      });
      
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
      
      const isBeforeCandidate =
        mode === "before" &&
        data.phase === "before:phase2_2_waiting_selection" &&
        data.optionalSpots &&
        Array.isArray(data.optionalSpots);

      const isBeforeConfirmed =
        mode === "before" && data.phase === "before:phase2_2_done";

      // Phase2-2.5: レスポンス適用をapplyRouteUpdateに統一
      if (isBeforeConfirmed) {
        applyRouteUpdate({
          routeInfo: data.routeInfo || null,
          routePlan: data.routePlan || null,
          spots: (data.routePlan?.spots ?? (Array.isArray(data.spots) ? data.spots : undefined)) as Spot[] | undefined,
          optionalSpots: [],
        });
        console.log("[page.tsx] sendMessageWithUserState Phase2-2 (before): Applied route update");
      } else if (isBeforeCandidate) {
        setOptionalSpots(data.optionalSpots);
        setSpots(data.optionalSpots);
        console.log("[page.tsx] sendMessageWithUserState Phase2-1 (before): Updated optionalSpots");
      } else if (mode === "after" && data.phase === "after:phase2_2_done") {
        console.log("[page.tsx] sendMessageWithUserState Phase2-2: Processing phase2_2_done response");
        
        // Phase2-2（確定/順番入替/削除）: spots + routePlan + routeInfo を同一 applyRouteUpdate で同時更新
        applyRouteUpdate({
          routeInfo: data.routeInfo || null,
          routePlan: data.routePlan || null,
          // routePlanが無い場合でも、after:phase2_2_done は data.spots（確定spots）を返す前提なのでフォールバックする
          spots: (data.routePlan?.spots ?? (Array.isArray(data.spots) ? data.spots : undefined)) as Spot[] | undefined,
          optionalSpots: data.optionalSpots && Array.isArray(data.optionalSpots) ? data.optionalSpots : undefined,
        });
        console.log("[page.tsx] sendMessageWithUserState Phase2-2: Applied route update via applyRouteUpdate");
      } else {
        // Phase2-1（候補提示）: routeInfo を触らず optionalSpots中心
        if (mode === "after") {
          applyRouteUpdate({
            optionalSpots: data.optionalSpots && Array.isArray(data.optionalSpots) ? data.optionalSpots : undefined,
          });
          console.log("[page.tsx] sendMessageWithUserState Phase2-1: Applied optionalSpots update");
        }

        // Phase2-1 または通常の処理: routeInfo の扱い
        if (data.routeInfo) {
          applyRouteUpdate({
            routeInfo: data.routeInfo,
          });
        } else {
          // Afterのdestination質問など（after-destination-select）はrouteInfoを消さない
          // routeInfoをnullにすると routeReady=false になり、Mapの描画が止まるため。
          if (mode === "after" && data.mode === "after-destination-select") {
            console.log("[page.tsx] sendMessageWithUserState: No routeInfo in response (after-destination-select), keeping current routeInfo");
          } else {
            applyRouteUpdate({
              routeInfo: null,
            });
          }
        }

        // RoutePlan の更新（Phase2-1）
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
          applyRouteUpdate({
            routePlan: newRoutePlan,
            spots: data.spots,
          });
        }
      }
      
      // Step2(C): stayモードはAI返信受信時にdraftへ反映（候補UIは未実装）
      if (mode === "stay" && data.reply) {
        const responseSpots = Array.isArray(data.routePlan?.spots)
          ? data.routePlan.spots
          : Array.isArray(data.spots)
            ? data.spots
            : null;
        if (responseSpots && responseSpots.length > 0) {
          setDraft({ spots: responseSpots, routePlan: data.routePlan ?? null });
        } else {
          const { spots, routePlan } = useSpotStore.getState();
          if (spots && spots.length > 0) {
            setDraft({ spots, routePlan: routePlan ?? null });
          }
        }
      }

      // AIの返答を追加
      if (data.reply) {
        addMessage(mode, { role: "assistant", content: data.reply });
        console.log("[Chat] add assistant message", { text: data?.reply?.slice(0, 80) });
      }
      
      // Phase2-1: Afterモードでは data.spots（= optionalSpots）のみを使用
      // confirmedSpots は routeInfo.origin/destination で持つため、setSpots には入れない
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
  }, [
    addMessage,
    applyRouteUpdate,
    clearDestination,
    clearOrigin,
    clearOriginInputMode,
    clearRouteInfo,
    clearRoutePlan,
    clearSpots,
    mode,
    setDestination,
    setOptionalSpots,
    setOrigin,
    setOriginInputMode,
    setRoutePlan,
    setSpots,
    setDraft,
  ]);

  type UserStateOverride = Partial<{
    origin: OriginInfo;
    destination: OriginInfo;
    originInputMode: "free" | "current_location" | undefined;
    tripId: string;
    selectedSpotId: string | null;
    selectedSpotSource: "map" | "chat" | null;
  }>;

  const onSend = useCallback(async (inputMessage: string, overrideUserState?: UserStateOverride) => {
    console.log("[onSend] called", { inputMessage, mode });
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
      console.log("[Chat] add user message", { text: inputMessage });

      // ② 現在の messages を安全に取得（最新値を参照）
      const currentMessages = useMessageStore.getState().getMessages(mode);
      const latestMessages = [
        ...currentMessages,
        { role: "user", content: inputMessage }
      ];

      // ③ ルート編集の意図を判定（簡易キーワードベース）
      const userText = inputMessage.trim();
      const isReverseCommand =
        userText === "順番を逆に" ||
        userText === "順番を逆" ||
        userText.includes("順番を逆に");
      
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

      // ④ エンドポイントを決定（「順番を逆に」は常に通常エンドポイント）
      const apiEndpoint = isReverseCommand
        ? `/api/koyo/${mode}` // ★after/editに行かない
        : isRouteEditIntent
          ? `/api/koyo/${mode}/edit`
          : `/api/koyo/${mode}`;

      // ⑤ API コール
      // リクエスト送信時に最新の origin と destination を取得
      const currentOrigin = useSpotStore.getState().origin;
      const currentDestination = useSpotStore.getState().destination;
      const currentRoutePlan = useSpotStore.getState().routePlan;
      const store = useSpotStore.getState();
      console.log("[page.tsx] Sending request with origin:", currentOrigin);
      console.log("[page.tsx] Sending request with destination:", currentDestination);
      console.log("[page.tsx] Is route edit intent?", isRouteEditIntent);
      console.log("[page.tsx] Is reverse command?", isReverseCommand);
      console.log("[page.tsx] Current routePlan:", currentRoutePlan?.planId);

      const storeUserState = {
        origin: currentOrigin,
        destination: mode === "after" ? currentDestination : undefined,
        originInputMode: originInputMode,
        tripId: store.tripId,
        selectedSpotId: store.selectedSpotId,
        selectedSpotSource: store.selectedSpotSource,
      };
      const mergedUserState = { ...storeUserState, ...(overrideUserState ?? {}) };

      const requestBody = isRouteEditIntent && currentRoutePlan && !isReverseCommand
        ? {
            routePlan: currentRoutePlan,
            userMessage: inputMessage,
          }
        : {
            messages: latestMessages,
            userState: {
              ...mergedUserState,
              // Afterモードの場合、ルート状態をuserStateに追加
              // 重要: routePlan.spotsを優先（Places API由来のスポットも含む）
              ...(mode === "after"
                ? {
                    routePlanId: store.routePlan?.planId ?? null,
                    spots: (store.routePlan?.spots as Spot[]) || store.spots || [],
                    routeInfo: store.routeInfo ?? null,
                  }
                : {}),
              ...(mode === "after"
                ? (() => {
                    // payload構築直前に最新の状態を取得
                    const currentSpots = store.spots; // 確定済み経由地（最新の値を取得）
                    const currentRouteInfo = store.routeInfo;
                    const currentOptionalSpots = store.optionalSpots;
                    
                    // Phase2-2完了後（確定済み経由地がある場合）は phase: "after:phase2_2_done" を送る
                    const phase = currentSpots.length > 0 ? "after:phase2_2_done" : "after:phase2_2_waiting_selection";
                    
                    // destination座標を確定（currentDestinationから優先、なければrouteInfoから）
                    let destCoords: { lat: number; lng: number } | undefined;
                    if (currentDestination) {
                      if (currentDestination.type === "pref-boundary" && currentDestination.pref) {
                        const prefBoundary = getPrefBoundary(currentDestination.pref as PrefectureKey);
                        if (prefBoundary) {
                          destCoords = prefBoundary;
                        }
                      } else if (currentDestination.lat && currentDestination.lng) {
                        destCoords = {
                          lat: currentDestination.lat,
                          lng: currentDestination.lng,
                        };
                      }
                    }
                    // currentDestinationから取得できない場合はrouteInfoから補助的に取得
                    if (!destCoords && currentRouteInfo?.destination) {
                      destCoords = currentRouteInfo.destination;
                    }
                    
                    return {
                      context: {
                        after: {
                          phase,
                          optionalSpots: currentOptionalSpots,
                          spots: currentSpots.length > 0 ? currentSpots : undefined, // 必ず最新の値を使用
                          // routeInfoは巨大なので、再生成に必要な最小情報だけ送る
                          routeInfoKey: "direct", // 直行ルートを意味するフラグ
                          origin: currentRouteInfo?.origin || KOYO_COORDINATES,
                          destination: destCoords,
                        },
                      },
                    };
                  })()
                : {}),
              ...(mode === "before"
                ? (() => {
                    const currentOptionalSpots = store.optionalSpots;
                    const phase =
                      currentOptionalSpots.length > 0
                        ? "before:phase2_2_waiting_selection"
                        : "before:phase2_1";
                    return {
                      context: {
                        before: {
                          phase,
                          optionalSpots: currentOptionalSpots,
                          routeInfoKey: "direct",
                          origin: currentOrigin,
                        },
                      },
                    };
                  })()
                : {}),
            },
          };
      console.log("[API] request", { endpoint: apiEndpoint, payload: requestBody });
      
      const res = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        throw new Error(`API Error: ${res.status}`);
      }

      const data = await res.json();
      console.log("[API] response", {
        ok: res.ok,
        status: res.status,
        reply: data?.reply,
      });

      // デバッグログ
      console.log("[page.tsx] API response:", data);
      console.log("[page.tsx] reply from API:", data.reply);
      console.log("[page.tsx] spots:", data.spots);
      console.log("[page.tsx] origin from API:", data.origin);
      console.log("[page.tsx] destination from API:", data.destination);
      console.log("[page.tsx] routeInfo:", data.routeInfo);
      console.log("[page.tsx] routeInfo.waypoints:", data.routeInfo?.waypoints);
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

      const isBeforeCandidate =
        mode === "before" &&
        data.phase === "before:phase2_2_waiting_selection" &&
        data.optionalSpots &&
        Array.isArray(data.optionalSpots);

      const isBeforeConfirmed =
        mode === "before" && data.phase === "before:phase2_2_done";

      // Phase2-2.5: レスポンス適用をapplyRouteUpdateに統一
      if (isBeforeConfirmed) {
        applyRouteUpdate({
          routeInfo: data.routeInfo || null,
          routePlan: data.routePlan || null,
          spots: (data.routePlan?.spots ?? (Array.isArray(data.spots) ? data.spots : undefined)) as Spot[] | undefined,
          optionalSpots: [],
        });
        console.log("[page.tsx] Phase2-2 (before): Applied route update");
      } else if (isBeforeCandidate) {
        setOptionalSpots(data.optionalSpots);
        setSpots(data.optionalSpots);
        console.log("[page.tsx] Phase2-1 (before): Updated optionalSpots");
      } else if (mode === "after" && data.phase === "after:phase2_2_done") {
        console.log("[page.tsx] Phase2-2: Processing phase2_2_done response");
        
        // Phase2-2（確定/順番入替/削除）: spots + routePlan + routeInfo を同一 applyRouteUpdate で同時更新
        applyRouteUpdate({
          routeInfo: data.routeInfo || null,
          routePlan: data.routePlan || null,
          // routePlanが無い場合でも、after:phase2_2_done は data.spots（確定spots）を返す前提なのでフォールバックする
          spots: (data.routePlan?.spots ?? (Array.isArray(data.spots) ? data.spots : undefined)) as Spot[] | undefined,
          optionalSpots: data.optionalSpots && Array.isArray(data.optionalSpots) ? data.optionalSpots : undefined,
        });
        console.log("[page.tsx] Phase2-2: Applied route update via applyRouteUpdate");
      } else {
        // Phase2-1（候補提示）: routeInfo を触らず optionalSpots中心
        if (mode === "after") {
          applyRouteUpdate({
            optionalSpots: data.optionalSpots && Array.isArray(data.optionalSpots) ? data.optionalSpots : undefined,
          });
          console.log("[page.tsx] Phase2-1: Applied optionalSpots update");
        }

        // Phase2-1 または通常の処理: routeInfo の扱い
        if (data.routeInfo) {
          console.log("[page.tsx] onSend: Applying routeInfo via applyRouteUpdate:", {
            origin: data.routeInfo.origin,
            destination: data.routeInfo.destination,
            waypointsCount: data.routeInfo.waypoints?.length || 0,
            waypoints: data.routeInfo.waypoints,
          });
          applyRouteUpdate({
            routeInfo: data.routeInfo,
          });
        } else {
          if (mode === "after" && data.mode === "after-destination-select") {
            console.log("[page.tsx] onSend: No routeInfo in response (after-destination-select), keeping current routeInfo");
          } else {
            console.log("[page.tsx] onSend: No routeInfo in response, clearing routeInfo");
            applyRouteUpdate({
              routeInfo: null,
            });
          }
        }

      // RoutePlan の更新（Phase2-1/legacy）
      // NOTE:
      // - Afterモードは Phase2-2.5 で applyRouteUpdate に統一済み
      // - Afterの data.spots は Phase2-1では optionalSpots（候補）として扱うため、ここで routePlan/spots を構築・上書きしない
      if (mode !== "after") {
        if (isRouteEditIntent && data.routePlan) {
          // 編集エンドポイントからのレスポンス: routePlanを更新
          applyRouteUpdate({
            routePlan: data.routePlan,
            spots: data.routePlan.spots as Spot[],
          });
          console.log("[page.tsx] Updated RoutePlan from edit via applyRouteUpdate:", data.routePlan.planId);
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

          applyRouteUpdate({
            routePlan,
            spots: data.spots,
          });
          console.log("[page.tsx] Created and saved RoutePlan via applyRouteUpdate:", routePlan.planId, "with", routePlan.spots.length, "spots");
        } else if (!isRouteEditIntent) {
          // spots または routeInfo が存在しない場合は RoutePlan をクリア
          applyRouteUpdate({
            routePlan: null,
          });
          console.log("[page.tsx] Cleared RoutePlan via applyRouteUpdate (no spots or routeInfo)");
        }
      }
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
      
        // ============================================================
      // スポット配列の受け取り処理（legacy）
        // ============================================================
      // NOTE:
      // - Afterモードは Phase2-2.5 で applyRouteUpdate に統一済み。
      // - Afterの data.spots は Phase2-1では optionalSpots（候補）であり、ここで setSpots/clearSpots すると
      //   「確定spotsの消去 → GoogleMapのガードが作動 → ルートが出ない」が発生する。
      if (mode !== "after") {
        if (data.spots && Array.isArray(data.spots) && data.spots.length > 0) {
        const firstSpot = data.spots[0];
        const hasSupabaseFormat = (
          Array.isArray(data.spots) &&
          firstSpot?.id &&
          (firstSpot.lat !== undefined && firstSpot.lng !== undefined) &&
          (firstSpot.city !== undefined || firstSpot.drive_minutes !== undefined)
        );

          console.log("[page.tsx] Format check:", {
            isArray: Array.isArray(data.spots),
            hasId: !!firstSpot?.id,
            hasLat: firstSpot?.lat !== undefined,
            hasLng: firstSpot?.lng !== undefined,
            hasCity: firstSpot?.city !== undefined,
            hasDriveMinutes: firstSpot?.drive_minutes !== undefined,
            firstSpot: firstSpot,
            hasSupabaseFormat,
            });

          if (hasSupabaseFormat) {
            console.log("[page.tsx] Received Supabase format spots:", data.spots.length);
            setSpots(data.spots);
          } else {
            console.warn("[page.tsx] Non-supabase format spots received; ignoring in legacy handler");
          }
        } else {
          console.log("[page.tsx] No spots found, clearing");
          clearSpots();
        }
      }

      // Step2(C): stayモードはAI返信受信時にdraftへ反映（候補UIは未実装）
      if (mode === "stay" && data.reply) {
        const responseSpots = Array.isArray(data.routePlan?.spots)
          ? data.routePlan.spots
          : Array.isArray(data.spots)
            ? data.spots
            : null;
        if (responseSpots && responseSpots.length > 0) {
          setDraft({ spots: responseSpots, routePlan: data.routePlan ?? null });
        } else {
          const { spots, routePlan } = useSpotStore.getState();
          if (spots && spots.length > 0) {
            setDraft({ spots, routePlan: routePlan ?? null });
          }
        }
      }

      // ④ AI の返答を追加
      if (data.reply) {
      addMessage(mode, { role: "assistant", content: data.reply });
      console.log("[Chat] add assistant message", { text: data?.reply?.slice(0, 80) });
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
  }, [
    addMessage,
    applyRouteUpdate,
    clearDestination,
    clearOrigin,
    clearOriginInputMode,
    clearSpots,
    destination,
    isLoading,
    mode,
    origin,
    originInputMode,
    routePlan,
    sendMessageWithUserState,
    setDestination,
    setInput,
    setIsLoading,
    setOptionalSpots,
    setOrigin,
    setOriginInputMode,
    setSpots,
    setDraft,
  ]);

  useEffect(() => {
    console.log("[AutoSend] check", {
      mode,
      selectedSpotId,
      selectedSpotSource,
      lastSelectionSentId,
    });
    if (
      mode === "stay" &&
      selectedSpotId &&
      selectedSpotSource === "map" &&
      lastSelectionSentId !== selectedSpotId
    ) {
      if (autoSendInFlightRef.current || autoSendLastSentIdRef.current === selectedSpotId) {
        return;
      }
      autoSendLastSentIdRef.current = selectedSpotId;
      autoSendInFlightRef.current = true;
      console.log("[AutoSend] FIRE", {
        mode,
        selectedSpotId,
        selectedSpotSource,
        lastSelectionSentId,
        message: "このスポットでお願いします",
      });
      const targetId = selectedSpotId;
      const send = async () => {
        setLastSelectionSentId(targetId);
        await onSend("このスポットでお願いします", {
          selectedSpotId: targetId,
          selectedSpotSource: "map",
        });
        setSelectedSpot(targetId);
        autoSendInFlightRef.current = false;
      };
      send();
    }
  }, [
    mode,
    selectedSpotId,
    selectedSpotSource,
    lastSelectionSentId,
    setLastSelectionSentId,
    setSelectedSpot,
    onSend,
  ]);

  return (
    <div className="relative min-h-screen">
      <BackgroundWrapper mode={mode} />

      <div className="relative z-10 flex flex-col items-center pt-8 pb-24 px-4">
        <ChatContainer mode={mode} setMode={setMode} messages={messages} isLoading={isLoading} />

        {/* 地図で見るボタン
            - 以前は「spotsがある場合のみ」表示だったが、Afterの直行ルート（waypoints=0）ではspotsが空でもrouteInfoが存在する。
            - routeInfo（origin/destination）があるなら地図でルート表示できるため、routeInfo優先で表示する。
        */}
        {(spots.length > 0 || !!routeInfo) && (
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

