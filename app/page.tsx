"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import BackgroundWrapper from "./koyo-lab-ui/BackgroundWrapper";
import ChatContainer from "./koyo-lab-ui/ChatContainer";
import ChatInput from "./koyo-lab-ui/ChatInput";
import { useKoyoMode, KoyoMode } from "./koyo-lab-ui/hooks/useKoyoMode";
import { useSpotStore } from "@/store/spots";

type Msg = { role: "user" | "assistant"; content: string };

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
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      content: INITIAL_MESSAGES.before,
    },
  ]);

  // マップ用スポット状態管理
  const setSpots = useSpotStore((s) => s.setSpots);
  const clearSpots = useSpotStore((s) => s.clearSpots);
  const spots = useSpotStore((s) => s.spots);

  // モードが変わったときに初期メッセージを更新し、spotsをクリア
  useEffect(() => {
    setMessages([
      {
        role: "assistant",
        content: INITIAL_MESSAGES[mode],
      },
    ]);
    // モード切り替え時に前のモードのspotsをクリア
    clearSpots();
  }, [mode, clearSpots]);

  // --- 追加：送信中の状態を管理 ---
  const [isLoading, setIsLoading] = useState(false);

  const onSend = async (inputMessage: string) => {
    if (!inputMessage.trim() || isLoading) return;

    // 送信中フラグ ON
    setIsLoading(true);

    try {
      // ① まずユーザーのメッセージを追加（安全に最新状態で追加）
      setMessages(prev => [
        ...prev,
        { role: "user", content: inputMessage }
      ]);

      // ② 現在の messages を安全に取得（最新値を参照したいので getLatestMessages を作る）
      const latestMessages = [
        ...messages,
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

      // スポットをマップ用に保存
      if (data.spots && Array.isArray(data.spots) && data.spots.length > 0) {
        console.log("[page.tsx] Setting spots:", data.spots);
        setSpots(data.spots);
      } else {
        console.log("[page.tsx] No spots found, clearing");
        clearSpots();
      }

      // ④ AI の返答を追加
      setMessages(prev => [
        ...prev,
        { role: "assistant", content: data.reply }
      ]);
    } catch (error) {
      console.error("Chat API error:", error);

      // エラー時のメッセージ
      setMessages(prev => [
        ...prev,
        {
          role: "assistant",
          content: "申し訳ありません。ネットワークエラーが発生しました。しばらくしてから再度お試しください。"
        }
      ]);
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

