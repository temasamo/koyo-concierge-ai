"use client";

import { useState } from "react";
import BackgroundWrapper from "./koyo-lab-ui/BackgroundWrapper";
import ChatContainer from "./koyo-lab-ui/ChatContainer";
import ChatInput from "./koyo-lab-ui/ChatInput";
import { useKoyoMode } from "./koyo-lab-ui/hooks/useKoyoMode";

type Msg = { role: "user" | "assistant"; content: string };

export default function Page() {
  const { mode, setMode } = useKoyoMode();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      content:
        "古窯旅館の旅コンシェルAIです。（開発モード）どのようなお手伝いをいたしましょうか？",
    },
  ]);

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

      // ③ API コール
      const res = await fetch("/api/koyo/before", {
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
        <ChatContainer mode={mode} setMode={setMode} messages={messages} />

        <div className="fixed left-0 right-0 bottom-0 pb-4 flex justify-center">
          <div className="w-full max-w-[480px] px-4">
            <ChatInput input={input} setInput={setInput} onSend={onSend} disabled={isLoading} />
          </div>
        </div>
      </div>
    </div>
  );
}

