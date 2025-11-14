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

  const onSend = () => {
    if (!input.trim()) return;

    const userMsg: Msg = { role: "user", content: input.trim() };
    setMessages((prev) => [...prev, userMsg]);

    const dummyReply: Msg = {
      role: "assistant",
      content: "メッセージを受け取りました。AI応答は後で実装予定です。",
    };
    setMessages((prev) => [...prev, dummyReply]);

    setInput("");
  };

  return (
    <div className="relative min-h-screen">
      <BackgroundWrapper mode={mode} />

      <div className="relative z-10 flex flex-col items-center pt-8 pb-24 px-4">
        <ChatContainer mode={mode} setMode={setMode} messages={messages} />

        <div className="fixed left-0 right-0 bottom-0 pb-4 flex justify-center">
          <div className="w-full max-w-[480px] px-4">
            <ChatInput input={input} setInput={setInput} onSend={onSend} />
          </div>
        </div>
      </div>
    </div>
  );
}

