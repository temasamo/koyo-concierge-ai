"use client";

export default function ChatInput({
  input,
  setInput,
  onSend,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
}) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="flex gap-2">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1 p-2 rounded border bg-white/80"
        placeholder="メッセージを入力..."
      />
      <button
        onClick={onSend}
        className="px-4 py-2 rounded bg-blue-600 text-white"
      >
        送信
      </button>
    </div>
  );
}

