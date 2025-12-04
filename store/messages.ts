// store/messages.ts
import { create } from "zustand";

export type Msg = { role: "user" | "assistant"; content: string };
export type KoyoMode = "before" | "stay" | "after";

type MessageStore = {
  // モードごとの会話履歴を管理
  messagesByMode: Record<KoyoMode, Msg[]>;
  getMessages: (mode: KoyoMode) => Msg[];
  setMessages: (mode: KoyoMode, messages: Msg[]) => void;
  addMessage: (mode: KoyoMode, message: Msg) => void;
  clearMessages: (mode: KoyoMode) => void;
  resetToInitial: (mode: KoyoMode, initialMessage: Msg) => void;
};

export const useMessageStore = create<MessageStore>((set, get) => ({
  messagesByMode: {
    before: [],
    stay: [],
    after: [],
  },
  getMessages: (mode) => get().messagesByMode[mode] || [],
  setMessages: (mode, messages) =>
    set((state) => ({
      messagesByMode: {
        ...state.messagesByMode,
        [mode]: messages,
      },
    })),
  addMessage: (mode, message) =>
    set((state) => ({
      messagesByMode: {
        ...state.messagesByMode,
        [mode]: [...(state.messagesByMode[mode] || []), message],
      },
    })),
  clearMessages: (mode) =>
    set((state) => ({
      messagesByMode: {
        ...state.messagesByMode,
        [mode]: [],
      },
    })),
  resetToInitial: (mode, initialMessage) =>
    set((state) => ({
      messagesByMode: {
        ...state.messagesByMode,
        [mode]: [initialMessage],
      },
    })),
}));

