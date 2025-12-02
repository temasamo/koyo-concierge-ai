"use client";

export default function ChatInput({
  input,
  setInput,
  onSend,
  disabled,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: (inputMessage: string) => void;
  disabled?: boolean;
}) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enterキーでの送信を無効化（送信ボタンのみで送信）
    // 誤送信を防ぐため
  };

  const handleSend = () => {
    if (!disabled) {
      onSend(input);
    }
  };

  return (
    <div className="flex gap-2">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className="flex-1 p-2 rounded border bg-white/80 text-gray-900 placeholder-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
        placeholder="メッセージを入力..."
      />
      <button
        onClick={handleSend}
        disabled={disabled}
        className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
      >
        送信
      </button>
    </div>
  );
}

