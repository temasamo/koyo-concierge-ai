/**
 * Pre-Checkin Intent Detection
 * ユーザーのメッセージからPre-Checkinモードへの遷移意図を検出する
 */

export function detectPreCheckinIntent(message: string): boolean {
  if (!message || typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim().toLowerCase();

  // Pre-Checkin関連のキーワード
  const preCheckinKeywords = [
    "チェックイン前",
    "到着前",
    "出発地",
    "出発",
    "どこから",
    "どこで",
    "どこへ",
    "出発地点",
    "スタート地点",
    "始まり",
    "最初",
    "到着まで",
    "到着するまで",
    "到着する前に",
    "到着前に",
    "古窯に到着するまで",
    "古窯に到着前に",
    "古窯に到着する前に",
    "古窯へ向かう",
    "古窯へ向かう途中",
    "古窯までの",
    "古窯までの道中",
    "古窯までのルート",
    "古窯までの観光",
    "古窯までのプラン",
    "古窯までの旅",
    "古窯までの旅行",
    "古窯までの観光地",
    "古窯までのスポット",
    "古窯までの見どころ",
    "古窯までの見所",
    "古窯までの観光スポット",
    "古窯までの観光プラン",
    "古窯までの旅行プラン",
    "古窯までの旅プラン",
    "古窯までの観光ルート",
    "古窯までの旅行ルート",
    "古窯までの旅ルート",
    "古窯までの観光コース",
    "古窯までの旅行コース",
    "古窯までの旅コース",
    "古窯までの観光地",
    "古窯までの観光スポット",
    "古窯までの見どころ",
    "古窯までの見所",
    "古窯までの観光地",
    "古窯までの観光スポット",
    "古窯までの見どころ",
    "古窯までの見所",
    "古窯までの観光地",
    "古窯までの観光スポット",
    "古窯までの見どころ",
    "古窯までの見所",
  ];

  // キーワードが含まれているかチェック
  return preCheckinKeywords.some((keyword) => normalizedMessage.includes(keyword));
}

/**
 * モード相違検出（Phase1.75）
 * 現在のモードとユーザーの質問内容がズレている場合を検出する
 * @param message ユーザーのメッセージ
 * @param currentMode 現在のモード（"before" | "stay" | "after"）
 * @returns { detected: boolean, reason?: string } 検出結果と理由
 */
export function detectModeMismatch(
  message: string,
  currentMode: "before" | "stay" | "after"
): { detected: boolean; reason?: string } {
  if (!message || typeof message !== "string") {
    return { detected: false };
  }

  const normalizedMessage = message.trim().toLowerCase();

  // Beforeモードで検出すべきキーワード（他のモードの内容）
  const beforeMismatchKeywords = [
    "宿泊中",
    "滞在中",
    "チェックイン後",
    "帰宅後",
    "チェックアウト後",
    "帰り道",
    "帰宅途中",
    "明日",
    "未来",
    "次の日",
  ];

  // Stayモードで検出すべきキーワード（他のモードの内容）
  const stayMismatchKeywords = [
    "帰宅後",
    "チェックアウト後",
    "帰り道",
    "帰宅途中",
    "明日",
    "未来",
    "次の日",
    "チェックイン前",
    "到着前",
  ];

  // Afterモードで検出すべきキーワード（他のモードの内容）
  const afterMismatchKeywords = [
    "明日",
    "未来",
    "次の日",
    "チェックイン前",
    "到着前",
    "宿泊中",
    "滞在中",
  ];

  let keywords: string[] = [];
  let reason: string | undefined;

  switch (currentMode) {
    case "before":
      keywords = beforeMismatchKeywords;
      if (keywords.some((k) => normalizedMessage.includes(k))) {
        // どのキーワードがマッチしたかで理由を決定
        if (normalizedMessage.includes("宿泊中") || normalizedMessage.includes("滞在中") || normalizedMessage.includes("チェックイン後")) {
          reason = "before->stay";
        } else if (normalizedMessage.includes("帰宅後") || normalizedMessage.includes("チェックアウト後") || normalizedMessage.includes("帰り道") || normalizedMessage.includes("帰宅途中")) {
          reason = "before->after";
        } else if (normalizedMessage.includes("明日") || normalizedMessage.includes("未来") || normalizedMessage.includes("次の日")) {
          reason = "before->future";
        }
      }
      break;
    case "stay":
      keywords = stayMismatchKeywords;
      if (keywords.some((k) => normalizedMessage.includes(k))) {
        if (normalizedMessage.includes("帰宅後") || normalizedMessage.includes("チェックアウト後") || normalizedMessage.includes("帰り道") || normalizedMessage.includes("帰宅途中")) {
          reason = "stay->after";
        } else if (normalizedMessage.includes("明日") || normalizedMessage.includes("未来") || normalizedMessage.includes("次の日")) {
          reason = "stay->future";
        } else if (normalizedMessage.includes("チェックイン前") || normalizedMessage.includes("到着前")) {
          reason = "stay->before";
        }
      }
      break;
    case "after":
      keywords = afterMismatchKeywords;
      if (keywords.some((k) => normalizedMessage.includes(k))) {
        if (normalizedMessage.includes("明日") || normalizedMessage.includes("未来") || normalizedMessage.includes("次の日")) {
          reason = "after->future";
        } else if (normalizedMessage.includes("チェックイン前") || normalizedMessage.includes("到着前")) {
          reason = "after->before";
        } else if (normalizedMessage.includes("宿泊中") || normalizedMessage.includes("滞在中")) {
          reason = "after->stay";
        }
      }
      break;
  }

  const detected = keywords.some((keyword) => normalizedMessage.includes(keyword));

  return { detected, reason };
}

