"use client";

import { KoyoMode } from "./hooks/useKoyoMode";

type Msg = { role: "user" | "assistant"; content: string };

export default function ChatContainer({
  mode,
  setMode,
  messages,
}: {
  mode: KoyoMode;
  setMode: (m: KoyoMode) => void;
  messages: Msg[];
}) {
  return (
    <div className="w-full max-w-[480px] bg-white/85 rounded-xl shadow-xl p-4 backdrop-blur">
      <p className="text-xs text-gray-600 mb-2">※ 開発LAB版</p>

      <h1 className="text-2xl font-bold mb-4 text-gray-900">
        古窯 旅コンシェルAI
      </h1>

      <div className="flex gap-2 mb-3 text-sm">
        <button
          onClick={() => setMode("before")}
          className={`px-3 py-1 rounded-full ${
            mode === "before" ? "bg-blue-600 text-white" : "bg-gray-200"
          }`}
        >
          旅行前
        </button>
        <button
          onClick={() => setMode("stay")}
          className={`px-3 py-1 rounded-full ${
            mode === "stay" ? "bg-blue-600 text-white" : "bg-gray-200"
          }`}
        >
          宿泊中
        </button>
        <button
          onClick={() => setMode("after")}
          className={`px-3 py-1 rounded-full ${
            mode === "after" ? "bg-blue-600 text-white" : "bg-gray-200"
          }`}
        >
          帰宅後
        </button>
      </div>

      <div className="h-[260px] overflow-y-auto space-y-2 text-sm">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${
              m.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`px-3 py-2 rounded-2xl max-w-[80%] ${
                m.role === "user"
                  ? "bg-blue-500 text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

