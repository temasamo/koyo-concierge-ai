"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import BackgroundWrapper from "./koyo-lab-ui/BackgroundWrapper";
import ChatContainer from "./koyo-lab-ui/ChatContainer";
import ChatInput from "./koyo-lab-ui/ChatInput";
import { useKoyoMode, KoyoMode } from "./koyo-lab-ui/hooks/useKoyoMode";
import { useSpotStore } from "@/store/spots";
import { useMessageStore } from "@/store/messages";
import type { Msg } from "@/store/messages";

// モードごとの初期メッセージ
const INITIAL_MESSAGES: Record<KoyoMode, string> = {
  before: "古窯の旅コンシェルAIでございます。旅前のご準備、お手伝いさせていただきます。まずは、どのような旅をお考えかお聞かせください。",
  stay: "古窯のフロントスタッフでございます。ご滞在中のご案内をさせていただきます。何かご不明な点やご要望がございましたら、お気軽にお申し付けください。",
  after: "古窯の旅コンシェルAIです。ご宿泊ありがとうございました。旅の思い出を大切に、何かご不明な点やお困りのことがございましたら、お気軽にお尋ねください。",
};

export default function Page() {
  const router = useRouter();
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

  // モードが変わったときに、そのモードの会話履歴が空なら初期メッセージを設定
  useEffect(() => {
    const currentMessages = useMessageStore.getState().getMessages(mode);
    if (currentMessages.length === 0) {
      resetToInitial(mode, {
        role: "assistant",
        content: INITIAL_MESSAGES[mode],
      });
    }
    // モード切り替え時に前のモードのspotsをクリア
    clearSpots();
  }, [mode, clearSpots, resetToInitial]);

  // --- 追加：送信中の状態を管理 ---
  const [isLoading, setIsLoading] = useState(false);

  const onSend = async (inputMessage: string) => {
    if (!inputMessage.trim() || isLoading) return;

    // 送信中フラグ ON
    setIsLoading(true);

    try {
      // ① まずユーザーのメッセージを追加
      addMessage(mode, { role: "user", content: inputMessage });

      // ② 現在の messages を安全に取得（最新値を参照）
      const currentMessages = useMessageStore.getState().getMessages(mode);
      const latestMessages = [
        ...currentMessages,
        { role: "user", content: inputMessage }
      ];

      // ③ モードに応じてAPIエンドポイントを決定
      const apiEndpoint = `/api/koyo/${mode}`;

      // ④ API コール
      const res = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: latestMessages,
        }),
      });

      if (!res.ok) {
        throw new Error(`API Error: ${res.status}`);
      }

      const data = await res.json();

      // デバッグログ
      console.log("[page.tsx] API response:", data);
      console.log("[page.tsx] spots:", data.spots);

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
      addMessage(mode, { role: "assistant", content: data.reply });
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

