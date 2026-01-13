// app/api/koyo/stay/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { createClient } from "@supabase/supabase-js";
import { matchSpot } from "../_utils/matchSpot";
import { KOYO_COORDINATES, SPOT_COORDINATE_FIXES } from "@/constants/koyo";
import { integratePlaces } from "../_utils/places";
import { detectStopIntent } from "../_utils/detectStopIntent";
import type { StopIntent } from "@/types/route";
import { detectModeMismatch } from "@/lib/koyo/intents";

// モデルは環境変数で差し替え可能
const CHAT_MODEL =
  process.env.KOYO_STAY_MODEL || "gpt-4o-mini";

// OpenAIクライアントを取得する関数（ビルド時のエラーを回避）
function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }
  return new OpenAI({ apiKey });
}

// Supabaseクライアントを取得する関数
function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      "Supabase environment variables are not set. Please set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey);
}

/**
 * ユーザーの質問が施設案内に関するものかを判定する関数
 * 利用・運用情報の問い合わせのみを対象とする
 * （外出スポットの意図は detectStopIntent で判定）
 */
function isFacilityQuery(userMessage: string): boolean {
  const normalizedMessage = userMessage.toLowerCase();
  
  // 利用情報系キーワードのみ（外出意図と区別するため）
  const facilityOnlyKeywords = [
    "利用時間",
    "何時",
    "何時まで",
    "営業",
    "使える",
    "利用可能",
    "貸切",
    "大浴場",
    "サウナ",
    "ルーム",
    "ラウンジ",
    "利用",
    "開いてる",
    "開いて",
  ];
  
  return facilityOnlyKeywords.some(keyword => normalizedMessage.includes(keyword));
}

/**
 * 時刻を "HH:mm" 形式の文字列に変換する関数
 * 前提: timeValue は 'HH:mm:ss' 形式の文字列（DBから返される形式）
 * Date変換は行わず、文字列をそのまま整形するだけ
 */
function formatTime(timeValue: string | Date | null): string {
  if (!timeValue) return "";
  
  try {
    // 文字列の場合（'HH:mm:ss' 形式）
    if (typeof timeValue === "string") {
      // 'HH:mm:ss' から 'HH:mm' に変換
      const timeMatch = timeValue.match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
      if (timeMatch) {
        return `${timeMatch[1]}:${timeMatch[2]}`;
      }
      // 既に 'HH:mm' 形式の場合はそのまま返す
      if (timeValue.match(/^\d{2}:\d{2}$/)) {
        return timeValue;
      }
      // パースできない場合は空文字を返す
      console.warn("[koyo-stay-facility] formatTime: Invalid time format:", timeValue);
      return "";
    }
    
    // Date オブジェクトの場合は従来通り（後方互換性のため）
    if (timeValue instanceof Date) {
      return timeValue.toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    }
    
    return "";
  } catch (error) {
    console.error("[koyo-stay-facility] formatTime error:", error);
    return "";
  }
}

/**
 * 施設データを取得してプロンプト用にフォーマットする関数
 */
async function getFacilityDataForPrompt(gender?: "male" | "female"): Promise<{
  availableNow: string;
  futureToday: string;
  nextAvailable: string;
  errorMessage?: string;
  requiresGender?: boolean; // 性別が必要かどうか
  genderSpecificFacilities?: string[]; // 性別で分かれる施設名のリスト
}> {
  // 性別未指定時: 男女で分かれる施設があるかチェック用の変数
  let requiresGender = false;
  let genderSpecificFacilities: string[] = [];
  try {
    const supabase = getSupabaseClient();
    
    // 施設名マッピングを取得
    const { data: facilities, error: facilitiesError } = await supabase
      .from("ryokan_facilities")
      .select("facility_key, name");
    
    if (facilitiesError) {
      console.error("[koyo-stay] Error fetching ryokan_facilities:", facilitiesError);
      return {
        availableNow: "",
        futureToday: "",
        nextAvailable: "",
        requiresGender: false,
        errorMessage: "施設名の取得に失敗しました。",
      };
    }
    
    const facilityNameMap = new Map<string, string>();
    if (facilities) {
      facilities.forEach((f: any) => {
        facilityNameMap.set(f.facility_key, f.name);
      });
    }
    
    // v_available_facilities_now を取得
    let availableNowData: any[] = [];
    try {
      const { data, error } = await supabase
        .from("v_available_facilities_now")
        .select("*");
      
      if (error) {
        console.error("[koyo-stay-facility] Error fetching v_available_facilities_now:", error);
      } else if (data) {
        // デバッグ: VIEWから取得した生データを確認
        console.log("[koyo-stay-facility] Raw data from v_available_facilities_now:", {
          count: data.length,
          sample: data.length > 0 ? data[0] : null,
          allKeys: data.length > 0 ? Object.keys(data[0]) : [],
        });
        
        // 時刻情報を詳細に確認
        if (data.length > 0) {
          console.log("[koyo-stay-facility] Time range details:");
          data.forEach((item: any, index: number) => {
            console.log(`  [${index}] ${item.facility_key || 'unknown'}:`, {
              gender: item.gender,
              available_from: item.available_from,
              available_to: item.available_to,
              from_type: typeof item.available_from,
              to_type: typeof item.available_to,
            });
          });
        }
        
        // 性別フィルタリング
        if (gender) {
          // 性別指定時: 指定された性別またはallのみ
          availableNowData = data.filter(
            (item: any) => item.gender === gender || item.gender === "all"
          );
          console.log(`[koyo-stay-facility] After gender filter (${gender}): ${availableNowData.length} records`);
        } else {
          // 性別未指定時: gender=all の施設だけを取得
          availableNowData = data.filter(
            (item: any) => item.gender === "all"
          );
          console.log(`[koyo-stay-facility] After gender filter (no gender, all only): ${availableNowData.length} records`);
          
          // 男女で分かれる施設があるかチェック（性別が必要かどうかの判定）
          const genderSpecificFacilityKeys = new Set<string>();
          data.forEach((item: any) => {
            if (item.gender === "male" || item.gender === "female") {
              genderSpecificFacilityKeys.add(item.facility_key);
            }
          });
          
          // 性別が必要な施設名のリストを作成
          genderSpecificFacilityKeys.forEach((facilityKey) => {
            const name = facilityNameMap.get(facilityKey);
            if (name) {
              genderSpecificFacilities.push(name);
            }
          });
          
          requiresGender = genderSpecificFacilities.length > 0;
        }
      } else {
        console.log("[koyo-stay-facility] No data returned from v_available_facilities_now");
      }
    } catch (error) {
      console.error("[koyo-stay] Error in v_available_facilities_now query:", error);
    }
    
    // v_facility_rules_future_today を取得
    let futureTodayData: any[] = [];
    try {
      const { data, error } = await supabase
        .from("v_facility_rules_future_today")
        .select("*");
      
      if (error) {
        console.error("[koyo-stay] Error fetching v_facility_rules_future_today:", error);
      } else if (data) {
        // 性別フィルタリング
        if (gender) {
          // 性別指定時: 指定された性別またはallのみ
          futureTodayData = data.filter(
            (item: any) => item.gender === gender || item.gender === "all"
          );
        } else {
          // 性別未指定時: gender=all の施設だけを取得
          futureTodayData = data.filter((item: any) => item.gender === "all");
        }
      }
    } catch (error) {
      console.error("[koyo-stay] Error in v_facility_rules_future_today query:", error);
    }
    
    // v_next_available_facility_time を取得
    let nextAvailableData: any[] = [];
    try {
      const { data, error } = await supabase
        .from("v_next_available_facility_time")
        .select("*");
      
      if (error) {
        console.error("[koyo-stay] Error fetching v_next_available_facility_time:", error);
      } else if (data) {
        nextAvailableData = data;
      }
    } catch (error) {
      console.error("[koyo-stay] Error in v_next_available_facility_time query:", error);
    }
    
    // facility_key単位でデータをまとめる
    const facilityGroups = new Map<string, {
      name: string;
      availableNow: any[];
      futureToday: any[];
      nextAvailable: any | null;
    }>();
    
    // 利用可能な施設（v_available_facilities_nowに1行でも該当）
    // 重要: facility_key単位でOR評価（some評価）
    // 1行でもavailableNowに該当すれば「利用可能」
    // every()や性別別の先行NG判定は使用しない
    availableNowData.forEach((item: any) => {
      const facilityKey = item.facility_key;
      if (!facilityGroups.has(facilityKey)) {
        facilityGroups.set(facilityKey, {
          name: facilityNameMap.get(facilityKey) || facilityKey,
          availableNow: [],
          futureToday: [],
          nextAvailable: null,
        });
      }
      // 無条件で追加（OR評価のため、1行でも該当すれば利用可能）
      facilityGroups.get(facilityKey)!.availableNow.push(item);
    });
    
    // デバッグログ: データ取得状況を確認
    console.log("[koyo-stay-facility] Data fetch summary:");
    console.log(`  - availableNowData: ${availableNowData.length} records`);
    console.log(`  - futureTodayData: ${futureTodayData.length} records`);
    console.log(`  - nextAvailableData: ${nextAvailableData.length} records`);
    console.log(`  - facilityGroups: ${facilityGroups.size} facilities`);
    
    // 今後の利用可能時間
    futureTodayData.forEach((item: any) => {
      const facilityKey = item.facility_key;
      if (!facilityGroups.has(facilityKey)) {
        facilityGroups.set(facilityKey, {
          name: facilityNameMap.get(facilityKey) || facilityKey,
          availableNow: [],
          futureToday: [],
          nextAvailable: null,
        });
      }
      facilityGroups.get(facilityKey)!.futureToday.push(item);
    });
    
    // 次回利用可能時刻
    nextAvailableData.forEach((item: any) => {
      const facilityKey = item.facility_key;
      if (!facilityGroups.has(facilityKey)) {
        facilityGroups.set(facilityKey, {
          name: facilityNameMap.get(facilityKey) || facilityKey,
          availableNow: [],
          futureToday: [],
          nextAvailable: null,
        });
      }
      facilityGroups.get(facilityKey)!.nextAvailable = item;
    });
    
    // プロンプト用にフォーマット（facility_key単位でまとめる）
    // 判定ルール: 1行でもavailableNowに該当すれば「利用可能」（OR評価/some評価）
    // 重要: facility_key単位で判定し、全行がNGな場合のみ「利用不可」
    // every()や性別別の先行NG判定は使用しない
    const formatAvailableNow = Array.from(facilityGroups.entries())
      .filter(([_, group]) => {
        // OR評価: 1行でもavailableNowに該当すれば利用可能
        return group.availableNow.length > 0;
      })
      .map(([facilityKey, group]) => {
        return `- facility_key: ${facilityKey}
  name: ${group.name}
  status: 利用可能
  available_records:
${group.availableNow.map((item: any) => `    - gender: ${item.gender || "unknown"}
      available_from: ${formatTime(item.available_from) || "N/A"}
      available_to: ${formatTime(item.available_to) || "N/A"}
      rule_type: ${item.rule_type || "unknown"}
      note: ${item.note || ""}`).join("\n")}`;
      })
      .join("\n");
    
    // デバッグログ: データ取得状況を確認
    console.log("[koyo-stay-facility] Data fetch summary:");
    console.log(`  - availableNowData: ${availableNowData.length} records`);
    console.log(`  - futureTodayData: ${futureTodayData.length} records`);
    console.log(`  - nextAvailableData: ${nextAvailableData.length} records`);
    console.log(`  - facilityGroups: ${facilityGroups.size} facilities`);
    
    // デバッグログ: facility_key単位の判定結果を確認
    console.log("[koyo-stay-facility] Facility availability by facility_key:");
    Array.from(facilityGroups.entries()).forEach(([facilityKey, group]) => {
      console.log(`  ${facilityKey}: availableNow=${group.availableNow.length} records (OR評価: ${group.availableNow.length > 0 ? "利用可能" : "利用不可"})`);
      if (group.availableNow.length > 0) {
        console.log(`    Records:`, group.availableNow.map((r: any) => `gender=${r.gender}, from=${r.available_from}, to=${r.available_to}`));
      }
    });
    
    // デバッグログ: フォーマット結果を確認
    console.log("[koyo-stay-facility] Formatted data:");
    console.log(`  - formatAvailableNow length: ${formatAvailableNow.length} chars`);
    console.log(`  - formatAvailableNow preview: ${formatAvailableNow.substring(0, 200)}`);
    
    const formatFutureToday = Array.from(facilityGroups.entries())
      .filter(([_, group]) => group.futureToday.length > 0)
      .map(([facilityKey, group]) => {
        return `- facility_key: ${facilityKey}
  name: ${group.name}
  future_records:
${group.futureToday.map((item: any) => `    - gender: ${item.gender || "unknown"}
      available_from: ${formatTime(item.available_from) || "N/A"}
      available_to: ${formatTime(item.available_to) || "N/A"}
      rule_type: ${item.rule_type || "unknown"}
      note: ${item.note || ""}`).join("\n")}`;
      })
      .join("\n");
    
    const formatNextAvailable = Array.from(facilityGroups.entries())
      .filter(([_, group]) => group.nextAvailable !== null)
      .map(([facilityKey, group]) => {
        const item = group.nextAvailable!;
        return `- facility_key: ${facilityKey}
  name: ${group.name}
  next_available_from: ${formatTime(item.next_available_from) || "N/A"}
  note: ${item.note || ""}`;
      })
      .join("\n");
    
    // デバッグログ: 最終的な返却データを確認
    console.log("[koyo-stay-facility] Final return data:");
    console.log(`  - availableNow: ${formatAvailableNow ? `${formatAvailableNow.length} chars` : "empty"}`);
    console.log(`  - futureToday: ${formatFutureToday ? `${formatFutureToday.length} chars` : "empty"}`);
    console.log(`  - nextAvailable: ${formatNextAvailable ? `${formatNextAvailable.length} chars` : "empty"}`);
    
    // 性別が必要な場合の早期リターン（性別未指定時のみ）
    if (!gender && requiresGender) {
      return {
        availableNow: formatAvailableNow || "",
        futureToday: formatFutureToday || "",
        nextAvailable: formatNextAvailable || "",
        requiresGender: true,
        genderSpecificFacilities: genderSpecificFacilities,
      };
    }
    
    return {
      availableNow: formatAvailableNow || "",
      futureToday: formatFutureToday || "",
      nextAvailable: formatNextAvailable || "",
      requiresGender: false,
    };
  } catch (error) {
    console.error("[koyo-stay] Error in getFacilityDataForPrompt:", error);
    return {
      availableNow: "",
      futureToday: "",
      nextAvailable: "",
      requiresGender: false,
      errorMessage: "施設データの取得中にエラーが発生しました。",
    };
  }
}

/**
 * Supabaseからスポット一覧を取得して、AIプロンプト用のテキストにフォーマット
 */
async function getSpotListForPrompt(): Promise<string> {
  try {
    const supabase = getSupabaseClient();
    const { data: spots, error } = await supabase
      .from("spot_master")
      .select("*")
      .order("name");

    if (error) {
      console.error("[koyo-stay] Supabase error:", error);
      return "【注意】スポット一覧の取得に失敗しました。";
    }

    if (!spots || spots.length === 0) {
      return "【注意】スポット一覧が空です。";
    }

    // スポット一覧をフォーマット
    const spotListText = spots
      .map(
        (s, idx) =>
          `[${idx + 1}] ${s.name}（カテゴリ: ${s.category || "未設定"}, 地域: ${
            s.city || "未設定"
          }, 季節: ${s.season || "未設定"}, 所要時間: ${s.drive_time || "未設定"}, lat:${s.lat || "未設定"}, lng:${
            s.lng || "未設定"
          }）`
      )
      .join("\n");

    return spotListText;
  } catch (error) {
    console.error("[koyo-stay] Error fetching spots:", error);
    return "【注意】スポット一覧の取得中にエラーが発生しました。";
  }
}

/**
 * 施設案内用のシステムプロンプトを生成（Facility Operation）
 */
async function getFacilitySystemPrompt(gender?: "male" | "female"): Promise<{ prompt: string; requiresGender?: boolean; genderSpecificFacilities?: string[] }> {
  const facilityData = await getFacilityDataForPrompt(gender);
  
  // 性別が必要な場合の処理
  if (facilityData.requiresGender && !gender) {
    return {
      prompt: "",
      requiresGender: true,
      genderSpecificFacilities: facilityData.genderSpecificFacilities || [],
    };
  }
  
  const prompt = `
あなたは、山形県・上山温泉「日本の宿 古窯」の
公式AIコンシェルジュです。

あなたの役割は、
宿泊者に対して「館内施設の利用可否・利用時間」を
正確かつ簡潔に案内することです。

あなたは以下の原則を必ず守ってください。

【最重要原則】
1. DBおよびVIEWに存在する情報のみを事実として扱う
2. 推測・補完・想像で時間や条件を作らない
3. あいまいな表現（まもなく・しばらく等）を使わない
4. 案内できない場合は、必ずフロント案内に誘導する
5. 施設名は必ず DB（ryokan_facilities.name）を使用する

【参照するデータ】
ryokan_facilities
- facility_key
- name（正式表示名）

v_available_facilities_now
- facility_key
- gender
- available_from
- available_to
- rule_type
- note

v_facility_rules_future_today
- facility_key
- gender
- available_from
- available_to
- rule_type
- note

v_next_available_facility_time
- facility_key
- next_available_from
- note

【内部判断フロー（厳守）】
1. v_available_facilities_now を最優先で確認する
   → facility_key 単位で判定する
   → 1行でも now に該当すれば「利用可能」
   → 全行がNG（利用不可）な場合のみ「利用不可」

2. 現在利用できない場合、
   v_next_available_facility_time を確認する
   → 次の利用可能時刻を案内する

3. 利用者が性別を指定している場合、
   v_facility_rules_future_today を確認し、
   性別による交代・制限を説明する

4. 本日中に該当データが存在しない場合、
   「本日のご利用は終了」と案内する

5. データ不整合・判断不能な場合は
   フロント案内に誘導する

【重要：性別未指定時の処理】
性別未指定の場合は、gender=all の施設のみを案内してください。
男女で分かれる施設については、性別を確認する必要があります。

【優先順位ルール】
・rule_type は cleaning > normal
・gender は 指定一致 > all
・時間帯は [available_from, available_to) として扱う
・同一条件が複数ある場合は、最も近い時間を採用する

【回答テンプレ適用ルール】
現在利用できる場合
現在、【{facility_name}】はご利用いただけます。
ご利用可能時間は【{available_to_formatted}】までです。

現在利用できない → 次がある場合
現在、【{facility_name}】はご利用いただけません。
次は【{next_available_from_formatted}】からご利用可能です。

性別交代制の場合
現在は【{current_gender_label}】のお時間帯です。
【{user_gender_label}】の方は【{next_available_from_formatted}】から
ご利用いただけます。

本日利用不可の場合
申し訳ありません。
【{facility_name}】の本日のご利用時間は終了しております。

案内不能の場合（必須）
恐れ入ります。
【{facility_name}】のご利用時間については、
フロントにてご案内しております。

【表現ルール】
・時間は「13時」「13時30分」「深夜1時」の形式で表記
・施設名は必ず正式名称を使用
・断定口調で、簡潔に案内する
・不要な雑談や感想は入れない

【人格・トーン】
・丁寧
・落ち着いている
・旅館スタッフと同じ目線
・親切だが簡潔

【禁止事項】
・独自判断で時間を推測すること
・DBにない施設を案内すること
・「たぶん」「〜と思います」などの不確実表現

【現在の施設データ（事実のみ）】
${facilityData.errorMessage ? `【注意】\n${facilityData.errorMessage}\n正確な案内ができない場合は、フロント案内に誘導してください。\n\n` : ""}
【現在利用可能な施設】
${facilityData.availableNow && facilityData.availableNow.length > 0 ? facilityData.availableNow : "該当データなし"}

【本日の今後の利用可能時間】
${facilityData.futureToday || "該当データなし"}

【次回利用可能時刻】
${facilityData.nextAvailable || "該当データなし"}

上記データは事実の羅列です。あなたはこのデータを基に、
ユーザーに対して正確で簡潔な案内を行ってください。
`;
  
  return { prompt, requiresGender: false };
}

/**
 * 旅中モードのシステムプロンプトを生成（Supabaseスポット一覧を自動注入）
 * Stay System Prompt (ver.2)
 */
async function getSystemPrompt(): Promise<string> {
  const spotListText = await getSpotListForPrompt();

  return `
あなたは「古窯 旅館コンシェルAI（滞在中）」としてふるまいます。
ユーザーが古窯にご滞在中（チェックイン〜チェックアウトまで）に、
今日の過ごし方・行動プランを最適化する役割のAIです。

【重要】あなたの返答は必ずJSON形式で返してください。テキストのみの返答は絶対に禁止です。

--------------------------------------------------
【あなたの人格（旅中AI）】
- 48歳前後の落ち着いた若女将。
- 丁寧で温かい接客の言葉遣い。
- 過度に堅苦しくない、親しみやすいコンシェルジュトーン。
- 地元の地理・季節・道路事情に詳しい。
- 滞在中の "困りごとを一緒に解決する姿勢" を大切にする。

--------------------------------------------------
【あなたの役割（Stay の定義）】
ユーザーが古窯に「ご宿泊している状態」で使う AI として、
今日 / 今から / この後 の行動を最適化します。

- 今日の予定の相談（例：午前中だけ、夕食まで、1日フリー など）
- 当日の天候に合わせた柔軟なプラン調整
- 「今から行ける場所」「半日でできること」の提案
- 館内設備（温泉・貸切風呂・売店・マッサージ）の案内
- 周辺観光（Supabaseのスポットのみ）との組み合わせ
- 混雑回避・安全配慮（雪道、夕方の道路凍結など）

※ Stay は「旅行当日の0:00 〜 チェックアウト後」までを担当します。

--------------------------------------------------
【重要制限（厳守）】
- 山形県外のスポットは提案禁止
- Supabase に存在しないスポット名は絶対に出してはいけません
- 地名・市名（例：蔵王温泉、天童市、上山市など）をスポットとして出すのは禁止です
- 架空スポットの生成は厳禁
- スポット名は必ず Supabase の登録名を正確に使用すること
- ユーザーの空き時間に合わせて適切なスポット数を提案すること

【重要：飲食・休憩スポットについて】
- 飲食店・カフェ・温泉・売店などの固有名詞（店名）は出さない
- 「この旅の流れの中で立ち寄りやすい場所で」
  「温かいラーメンを楽しむ」
  など抽象的な表現を使用する
- NG例：「◯◯でラーメン」「食事処△△」

--------------------------------------------------
【安全配慮（必須）】
冬季（12〜3月）は必ず以下の配慮を加えること：
- 雪道・凍結の注意
- 日没時間（夕方4〜5時）の早さ
- 車での移動の負担への配慮
- 「無理のない範囲で」のニュアンスを添える

--------------------------------------------------
【利用できるスポット（Supabase データのみ）】
以下は Supabase から取得した「公式スポット一覧」です。
この一覧にあるスポット名のみ、プランに使用できます。
一覧にないスポットは、名前が似ていても **絶対に使用禁止**。

${spotListText}

--------------------------------------------------
【プラン出力仕様（最重要）】
**必ず以下のJSON形式で返してください。テキストのみの返答は禁止です。**

{
  "reply": "若女将として温かく丁寧な文章（今日の状況を踏まえてわかりやすく案内。必ず提案するスポット名を含めてください）",
  "plan": [
    {
      "title": "○時間プラン / 今日のおすすめ",
      "spots": [
        {
          "id": "SupabaseのID（必須）",
          "name": "Supabaseのname（必須）"
        }
      ],
      "description": "プランの説明"
    }
  ]
}

**必須条件：**
- 必ずJSON形式で返す（テキストのみは不可）
- reply と plan の両方を含める
- **【最重要】replyには必ず提案するスポット名を自然な文章で含めること**
  - reply内でスポット名を言及する場合、必ず plan[0].spots[].name の正確な名称を使用すること
  - plan[0].spots に含まれるすべてのスポット名を reply に含めること
  - **replyで説明する順番も plan[0].spots の順番と完全に一致させてください**
  - スポット名を列挙するだけではなく、自然な文章に組み込むこと
  - 例：plan[0].spots が [「三淵渓谷カヌーツアー」「最上川舟下り」「蔵王お釜」] の場合、replyは「まずは三淵渓谷カヌーツアーで清流を楽しみ、その後は最上川舟下りでのんびりとした時間をお過ごしください。最後に蔵王お釜で、息をのむ絶景を堪能します。」のように、spotsの順番通りに記述すること
- JSONの前後に説明文やコードブロック（\`\`\`）は付けない
- spots配列内の各スポットには **id と name のみ** を含める（lat/lngは不要）
- Supabase にないスポットは含めない（推測や略称は禁止）
- スポット数は 3〜6 件程度
- plan配列は1件以上返すこと

--------------------------------------------------
【口調】
- 落ち着いた丁寧さ
- 近すぎず遠すぎない、旅館スタッフとして自然な距離感
- 優しく、安心感のあるトーン

--------------------------------------------------
【出力の必須条件】
1. まず、若女将としての丁寧な文章を返す
2. **必ず文章の後にJSON形式でplan配列を返す**
3. JSONは { "plan": [...] } の形式で返すこと
4. JSONの前後に説明文やコードブロックは付けない

以上のルールに従い、
「旅中AIとしての丁寧な案内」＋「今日の行動プランJSON」を返してください。
JSON形式で返さない場合は、プラン提案ができません。
`;
}

/**
 * AIの応答からplan配列を抽出する関数
 * 新しい形式: { plan: [{ title: "", spots: [{ name: "", id: "" }], description: "" }] }
 */
async function extractPlanFromReply(reply: string): Promise<any[] | undefined> {
  try {
    let planArray: any[] | undefined;

    // コードブロック（```json や ```）を除去
    let cleanedReply = reply;
    cleanedReply = cleanedReply.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    cleanedReply = cleanedReply.replace(/```[\s\S]*?```/g, '');

    // デバッグログ
    console.log("[koyo-stay] AI reply (first 500 chars):", cleanedReply.substring(0, 500));

    // まず、JSON形式のレスポンスを試す（全体がJSONの場合）
    try {
      const jsonResponse = JSON.parse(cleanedReply);
      if (jsonResponse.plan && Array.isArray(jsonResponse.plan)) {
        planArray = jsonResponse.plan;
        console.log("[koyo-stay] Found plan in full JSON response");
      }
    } catch {
      // JSON形式でない場合は、テキストから抽出を試す
    }

    // JSON形式で取得できなかった場合、テキストから抽出
    if (!planArray) {
      // テキスト内に埋め込まれたJSONを抽出する
      // 方法1: { "plan": [...] } を含むJSONオブジェクト全体を探す
      let jsonStart = cleanedReply.indexOf('{"plan"');
      if (jsonStart === -1) {
        jsonStart = cleanedReply.indexOf("{\"plan\"");
      }
      if (jsonStart === -1) {
        jsonStart = cleanedReply.indexOf("{ 'plan'");
      }
      
      if (jsonStart !== -1) {
        // { から始まるJSONオブジェクトの終わりを見つける
        let braceCount = 0;
        let jsonEnd = jsonStart;
        for (let i = jsonStart; i < cleanedReply.length; i++) {
          if (cleanedReply[i] === '{') braceCount++;
          if (cleanedReply[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              jsonEnd = i + 1;
              break;
            }
          }
        }
        
        if (jsonEnd > jsonStart) {
          try {
            const jsonString = cleanedReply.substring(jsonStart, jsonEnd);
            const planObj = JSON.parse(jsonString);
            if (planObj.plan && Array.isArray(planObj.plan)) {
              planArray = planObj.plan;
              console.log("[koyo-stay] Found plan in extracted JSON object");
            }
          } catch (parseError) {
            console.warn("[koyo-stay] Failed to parse extracted JSON:", parseError);
          }
        }
      }
      
      // 方法2: 正規表現で { "plan": [...] } 形式を探す（フォールバック）
      if (!planArray) {
        const planMatch = cleanedReply.match(/\{\s*"plan"\s*:\s*\[[\s\S]*?\]\s*\}/);
        if (planMatch) {
          try {
            const planObj = JSON.parse(planMatch[0]);
            if (planObj.plan && Array.isArray(planObj.plan)) {
              planArray = planObj.plan;
              console.log("[koyo-stay] Found plan in regex match");
            }
          } catch (parseError) {
            console.warn("[koyo-stay] Failed to parse regex matched JSON:", parseError);
          }
        }
      }
      
      // 方法3: 最も外側の { } を探す（最後の試み）
      if (!planArray) {
        const outerMatch = cleanedReply.match(/\{[\s\S]*"plan"[\s\S]*\}/);
        if (outerMatch) {
          try {
            const planObj = JSON.parse(outerMatch[0]);
            if (planObj.plan && Array.isArray(planObj.plan)) {
              planArray = planObj.plan;
              console.log("[koyo-stay] Found plan in outer match");
            }
          } catch (parseError) {
            console.warn("[koyo-stay] Failed to parse outer match JSON:", parseError);
          }
        }
      }
      
      if (!planArray) {
        console.warn("[koyo-stay] No plan JSON pattern found in reply");
        console.warn("[koyo-stay] Reply preview:", cleanedReply.substring(0, 500));
      }
    }

    if (!planArray || planArray.length === 0) {
      console.log("[koyo-stay] Extracted plan array: No plan found");
      return undefined;
    }
    
    console.log(`[koyo-stay] Extracted plan array: Found ${planArray.length} plans`);

    // plan[0].spotsが空または存在しない場合はundefinedを返す
    const firstPlan = planArray[0];
    if (!firstPlan || !firstPlan.spots || !Array.isArray(firstPlan.spots) || firstPlan.spots.length === 0) {
      return undefined;
    }

    return planArray;
  } catch (error) {
    console.error("[koyo-stay] Plan extraction error:", error);
    return undefined;
  }
}

/**
 * plan[0].spotsからスポットを抽出し、Supabaseとマッチングする関数
 * IDを最優先で使用し、一致しない場合はnameでマッチング
 */
async function extractAndMatchSpots(planArray: any[]): Promise<any[] | undefined> {
  try {
    if (!planArray || planArray.length === 0) {
      return undefined;
    }

    const firstPlan = planArray[0];
    if (!firstPlan || !firstPlan.spots || !Array.isArray(firstPlan.spots) || firstPlan.spots.length === 0) {
      return undefined;
    }

    const aiSpots = firstPlan.spots;

    // Supabaseから全スポットを取得
    const supabase = getSupabaseClient();
    const { data: supabaseSpots } = await supabase
      .from("spot_master")
      .select("*");

    if (!supabaseSpots || supabaseSpots.length === 0) {
      console.warn("[koyo-stay] No Supabase spots found");
      return undefined;
    }

    // AIが返したスポットをSupabase形式に変換
    const matchedSpots: any[] = [];
    const usedSpotIds = new Set<string>();

    for (const aiSpot of aiSpots) {
      let matched: any = null;

      // 1. IDでマッチングを試す（最優先）
      if (aiSpot.id) {
        matched = supabaseSpots.find(
          (s) => !usedSpotIds.has(s.id) && s.id === aiSpot.id
        );
      }

      // 2. IDでマッチしない場合は、nameで正規化マッチング
      if (!matched && aiSpot.name) {
        matched = matchSpot(aiSpot.name, supabaseSpots, usedSpotIds);
      }

      if (matched) {
        // 座標の修正があるかチェック
        const coordinateFix = SPOT_COORDINATE_FIXES[matched.id];
        const finalLat = coordinateFix ? coordinateFix.lat : matched.lat;
        const finalLng = coordinateFix ? coordinateFix.lng : matched.lng;
        
        if (coordinateFix) {
          console.log(`[koyo-stay] Applying coordinate fix for "${matched.name}" (${matched.id}): ${matched.lat},${matched.lng} -> ${finalLat},${finalLng}`);
        }
        
        // Supabase形式の完全なデータを使用
        matchedSpots.push({
          id: matched.id,
          name: matched.name,
          lat: finalLat,
          lng: finalLng,
          category: matched.category,
          city: matched.city,
          season: matched.season,
          drive_time: matched.drive_time,
          walk_time: matched.walk_time,
          stay_time: matched.stay_time,
          url: matched.url,
          tags: matched.tags,
          drive_minutes: matched.drive_time
            ? parseInt(matched.drive_time.match(/\d+/)?.[0] || "0")
            : null,
          source: "db", // DBスポットであることを明示
        });
        usedSpotIds.add(matched.id);
        console.log(`[koyo-stay] Matched spot: "${aiSpot.name || aiSpot.id}" -> "${matched.name}" (Supabase ID: ${matched.id})`);
      } else {
        console.warn(`[MATCH WARNING] No match found for: "${aiSpot.name || aiSpot.id}"`);
      }
    }

    return matchedSpots.length > 0 ? matchedSpots : undefined;
  } catch (error) {
    console.error("[koyo-stay] Spot matching error:", error);
    return undefined;
  }
}

/**
 * replyからJSON部分を除去してクリーンなメッセージを返す関数
 * 新しい形式: { plan: [...] } に対応
 * スポット名は保持する（reply部分に含まれている場合はそのまま返す）
 */
function cleanReplyMessage(reply: string): string {
  // コードブロック（```json や ```）を除去
  let cleanedReply = reply;
  cleanedReply = cleanedReply.replace(/```json\s*/g, '').replace(/```\s*/g, '');
  cleanedReply = cleanedReply.replace(/```[\s\S]*?```/g, '');
  
  // まず、JSON形式のレスポンスを試す
  try {
    const jsonResponse = JSON.parse(cleanedReply);
    if (jsonResponse.reply && typeof jsonResponse.reply === "string") {
      // reply部分をそのまま返す（スポット名が含まれている場合は保持される）
      return jsonResponse.reply;
    }
  } catch {
    // JSON形式でない場合は、テキストから抽出を試す
  }

  // { "reply": "...", "plan": [...] } 形式のJSONからreply部分を抽出
  const fullJsonMatch = cleanedReply.match(/\{\s*"reply"\s*:\s*"([^"]*)"\s*,\s*"plan"\s*:\s*\[[\s\S]*?\]\s*\}/);
  if (fullJsonMatch && fullJsonMatch[1]) {
    return fullJsonMatch[1];
  }

  // { "plan": [...] } 形式のJSONを削除（reply部分が別にある場合）
  let cleaned = cleanedReply.replace(/\{\s*"plan"\s*:\s*\[[\s\S]*?\]\s*\}/g, "").trim();
  
  // { "reply": "..." } 形式からreply部分を抽出
  const replyMatch = cleaned.match(/\{\s*"reply"\s*:\s*"([^"]*)"\s*[,}]/);
  if (replyMatch && replyMatch[1]) {
    return replyMatch[1];
  }

  // 従来の配列形式も削除（後方互換性のため）
  cleaned = cleaned.replace(/\[\s*\{[\s\S]*?\}\s*(,\s*\{[\s\S]*?\}\s*)*\]/g, "").trim();

  // 「--」や余計な区切り文字が残る場合も削除
  return cleaned.replace(/--/g, "").trim();
}

/**
 * Places API検索結果が0件の場合、reply内の断定表現を抽象表現に置き換える
 * フェーズ1.5: AIが嘘をつかないように、事実に基づかない断定表現を弱める
 */
function sanitizeReplyForFailedPlaces(
  reply: string,
  stopIntent: StopIntent | null
): string {
  if (!stopIntent || stopIntent.type !== "lunch") {
    // lunch以外は対象外（フェーズ1.5ではlunchのみ）
    return reply;
  }
  
  let sanitized = reply;
  
  // 山形牛・米沢牛などの特定食材名の断定表現を削除
  sanitized = sanitized.replace(/山形牛[^。]*。/g, "旅の流れに合わせて、周辺で食事の時間をお取りください。");
  sanitized = sanitized.replace(/米沢牛[^。]*。/g, "旅の流れに合わせて、周辺で食事の時間をお取りください。");
  
  // 名物・特定料理名の断定表現を削除
  sanitized = sanitized.replace(/名物[^。]*。/g, "地元ならではの食事を楽しむ時間を設けるのもおすすめです。");
  sanitized = sanitized.replace(/芋煮[^。]*。/g, "地元ならではの温かい食事を楽しむ時間を設けるのもおすすめです。");
  sanitized = sanitized.replace(/ラーメン[^。]*。/g, "旅の流れに合わせて、温かい食事の時間をお取りください。");
  sanitized = sanitized.replace(/そば[^。]*。/g, "旅の流れに合わせて、食事の時間をお取りください。");
  
  // 特定体験の断定表現を弱める
  sanitized = sanitized.replace(/地元の味[^。]*。/g, "地元ならではの食事を楽しむ時間を設けるのもおすすめです。");
  sanitized = sanitized.replace(/〇〇[^。]*。/g, "周辺で立ち寄りやすい食事スポットで、旅の流れに合わせて食事の時間をお取りください。");
  
  return sanitized;
}

/**
 * 施設案内AIのハンドラー関数
 */
async function handleFacilityOperation(
  userMessages: ChatCompletionMessageParam[],
  gender?: "male" | "female"
): Promise<NextResponse> {
  try {
    // ハイブリッド方式: リクエストボディのgenderを最優先、未指定時のみmessagesから抽出
    let finalGender: "male" | "female" | undefined = gender;
    
    if (!finalGender) {
      // フォールバック抽出: 直近のユーザー発話から性別を抽出
      const lastUserMessage = userMessages
        .filter((m) => m.role === "user")
        .pop();
      
      if (lastUserMessage && typeof lastUserMessage.content === "string") {
        const userText = lastUserMessage.content;
        
        // 性別検出を2系統に分ける
        // 1. 話者の性別表明パターン（selfDeclaration）
        //    「男性ですが」「女性です」「男です」「女です」など
        //    日本語の文字境界を考慮して \b を削除
        const selfDeclarationPattern = /(?:男性|女性|男|女|male|female)(?:ですが|です|だ|で|の者|でございます)/i;
        const selfDeclarationMatches = userText.match(selfDeclarationPattern);
        
        // 2. 質問対象の性別指定パターン（questionTarget）
        //    「女性は」「男性の」「女の」「男の」など
        const questionTargetPattern = /(?:男性|女性|男|女|male|female)(?:は|の|が)/i;
        const questionTargetMatches = userText.match(questionTargetPattern);
        
        // 3. 「男」「女」単独も検出対象（文脈判断が必要だが、まずは単純に検出）
        const simpleGenderPattern = /(?:男性|女性|男|女|male|female)/i;
        const simpleMatches = userText.match(simpleGenderPattern);
        
        // デバッグログ
        console.log("[koyo-stay-facility] Gender detection debug:", {
          userText,
          selfDeclarationMatches,
          questionTargetMatches,
          simpleMatches,
        });
        
        // 話者の性別表明を優先的に検出
        if (selfDeclarationMatches && selfDeclarationMatches.length > 0) {
          const matchedText = selfDeclarationMatches[0].toLowerCase();
          if (matchedText.includes("男性") || matchedText.includes("男") || matchedText.includes("male")) {
            finalGender = "male";
            console.log("[koyo-stay-facility] Self-declared gender detected: male");
          } else if (matchedText.includes("女性") || matchedText.includes("女") || matchedText.includes("female")) {
            finalGender = "female";
            console.log("[koyo-stay-facility] Self-declared gender detected: female");
          }
        }
        // 話者の性別表明がない場合、単純な性別語句を検出（「男」「女」単独も含む）
        else if (simpleMatches && simpleMatches.length === 1 && !questionTargetMatches) {
          // 質問対象の性別指定がない場合のみ、話者の性別として扱う
          const matchedText = simpleMatches[0].toLowerCase();
          if (matchedText === "男性" || matchedText === "男" || matchedText === "male") {
            finalGender = "male";
            console.log("[koyo-stay-facility] Gender detected by fallback (simple): male");
          } else if (matchedText === "女性" || matchedText === "女" || matchedText === "female") {
            finalGender = "female";
            console.log("[koyo-stay-facility] Gender detected by fallback (simple): female");
          }
        } else if (simpleMatches && simpleMatches.length > 1) {
          // 複数マッチ時は性別未確定（家族代表問い合わせなど）
          console.log("[koyo-stay-facility] Multiple gender matches detected, keeping gender undefined");
        }
        
        // 質問対象の性別指定が検出された場合のログ
        if (questionTargetMatches && questionTargetMatches.length > 0) {
          console.log("[koyo-stay-facility] Question target gender detected (not self-declaration)");
        }
        
        // 最終的な finalGender の状態をログ出力
        console.log("[koyo-stay-facility] Final gender after detection:", finalGender);
      }
    }
    
    const systemPrompt = await getFacilitySystemPrompt(finalGender);
    
    // 性別が必要な場合の処理
    if (systemPrompt.requiresGender && !finalGender) {
      // 性別が必要な施設がある場合、確認質問を返す
      const facilityNames = systemPrompt.genderSpecificFacilities || [];
      const facilityList = facilityNames.length > 0 
        ? facilityNames.join("、")
        : "一部の施設";
      
      return NextResponse.json({
        reply: `恐れ入ります。${facilityList}については、性別によって利用時間が異なります。\n\n男性ですか？女性ですか？`,
        plan: [],
        spots: [],
        routeInfo: null,
        requiresGender: true,
      });
    }
    
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt.prompt },
      ...userMessages,
    ];
    
    const openai = getOpenAIClient();
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      temperature: 0.7,
      // JSON制約なし（replyのみ返す）
    });
    
    const reply = completion.choices[0]?.message?.content ?? "";
    
    // デバッグログ
    console.log("[koyo-stay-facility] AI reply:", reply.substring(0, 500));
    
    // レスポンス形式を統一（plan/spotsは空配列、routeInfoはnull）
    return NextResponse.json({
      reply: reply,
      plan: [],
      spots: [],
      routeInfo: null,
      usage: completion.usage,
      debug: { branch: "stay:facility_query" },
    });
  } catch (error: any) {
    console.error("[koyo-stay-facility] ❌ BRANCH: facility_query ERROR:", error);
    console.error("[koyo-stay-facility] error:", error);
      return NextResponse.json(
      {
        error: "施設案内AIの応答生成中にエラーが発生しました。",
        detail: error?.message ?? String(error),
        reply: "恐れ入ります。施設のご利用時間については、フロントにてご案内しております。",
        plan: [],
        spots: [],
        routeInfo: null,
        debug: { branch: "stay:facility_query:error" },
      },
      { status: 500 }
      );
    }
}

/**
 * プラン提案AIのハンドラー関数（既存ロジック）
 */
async function handleStayPlanner(
  userMessages: ChatCompletionMessageParam[]
): Promise<NextResponse> {
  try {
    // 最後のユーザーメッセージを取得
    const lastUserMessage = userMessages.filter((m) => m.role === "user").pop();
    const userMessage = typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "";

    // Supabaseからスポット一覧を取得してシステムプロンプトを生成
    const systemPrompt = await getSystemPrompt();

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...userMessages,
    ];

    const openai = getOpenAIClient();
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      temperature: 0.7,
      response_format: { type: "json_object" },
    });

    const reply = completion.choices[0]?.message?.content ?? "";

    // デバッグ: AIの応答をログ出力
    console.log("[koyo-stay] AI reply (first 500 chars):", reply.substring(0, 500));

    // plan配列を抽出
    let planArray = await extractPlanFromReply(reply);
    console.log("[koyo-stay] Extracted plan array:", planArray ? `Found ${planArray.length} plans` : "No plan found");

    // plan配列が取得できない場合、古い形式（配列形式）を試す
    if (!planArray) {
      console.log("[koyo-stay] Trying to extract old format (array)...");
      try {
        // より安全な正規表現で配列を探す
        const jsonMatch = reply.match(/\[\s*\{[\s\S]*?\}\s*(,\s*\{[\s\S]*?\}\s*)*\]/);
        if (jsonMatch) {
          try {
            const jsonString = jsonMatch[0];
            const spots = JSON.parse(jsonString);
            if (Array.isArray(spots) && spots.length > 0) {
              // 古い形式を新しい形式に変換
              planArray = [{
                title: "今日のおすすめ",
                spots: spots,
                description: ""
              }];
              console.log("[koyo-stay] Converted old format to new format");
            }
          } catch (parseError) {
            console.warn("[koyo-stay] Failed to parse old format array:", parseError);
          }
        }
      } catch (error) {
        console.warn("[koyo-stay] Failed to extract old format:", error);
      }
    }

    // plan[0].spotsからスポットを抽出し、Supabaseとマッチング
    let matchedSpots: any[] | undefined;
    let finalPlan: any[] | undefined;
    let placesApiFailed = false;
    let stopIntent: ReturnType<typeof detectStopIntent> = null;

    if (planArray && planArray.length > 0) {
      matchedSpots = await extractAndMatchSpots(planArray);
      
      // 途中立ち寄り意図を検出してPlaces APIを呼び出す（extractAndMatchSpots後、ルート確定前）
      if (matchedSpots && matchedSpots.length > 0) {
        stopIntent = detectStopIntent(userMessage);
        const result = await integratePlaces(matchedSpots, stopIntent);
        matchedSpots = result.spots;
        placesApiFailed = result.placesApiFailed;
      }

      // plan配列を構築（plan[0].spotsをマッチング済みスポットに置き換え）
      if (matchedSpots && matchedSpots.length > 0) {
        finalPlan = planArray.map((plan, index) => {
          if (index === 0) {
            // plan[0]のspotsをマッチング済みスポットに置き換え
            return {
              ...plan,
              spots: matchedSpots!.map((spot) => ({
                name: spot.name,
                id: spot.id,
              })),
            };
          }
          return plan;
        });
      } else {
        // スポットが0件の場合はplanを返さない
        finalPlan = undefined;
      }
    }

    // replyからJSON部分を除去してクリーンなメッセージにする
    let cleanReply = cleanReplyMessage(reply);
    
    // Places API検索結果が0件の場合、断定表現を抽象表現に置き換える
    if (placesApiFailed && stopIntent) {
      cleanReply = sanitizeReplyForFailedPlaces(cleanReply, stopIntent);
    }
    
    // Places API結果はreplyに追記しない（フェーズ1: AIは店名を知らない）
    
    // デバッグログ
    console.log("[koyo-stay] Cleaned reply:", cleanReply);
    console.log("[koyo-stay] Cleaned reply contains spot names:", 
      matchedSpots && matchedSpots.length > 0 
        ? matchedSpots.some(spot => cleanReply.includes(spot.name))
        : false
    );

    // レスポンスを構築
    const response: any = {
      reply: cleanReply,
      usage: completion.usage,
    };

    // planがある場合のみ追加
    if (finalPlan && finalPlan.length > 0) {
      response.plan = finalPlan;
    }

    // フロントエンド互換性のため、plan[0].spotsから抽出した完全なSupabase形式のスポットデータを返す
    if (matchedSpots && matchedSpots.length > 0) {
      response.spots = matchedSpots;
    }
    
    // routeInfo を構築（Stayモード：originは古窯固定）
    const waypoints =
      matchedSpots && Array.isArray(matchedSpots)
        ? matchedSpots
            .filter((s: any) => {
              // 座標の型と値の検証を強化
              const isValid = 
                s.lat != null && 
                s.lng != null &&
                typeof s.lat === "number" &&
                typeof s.lng === "number" &&
                !isNaN(s.lat) &&
                !isNaN(s.lng) &&
                s.lat >= -90 && s.lat <= 90 &&
                s.lng >= -180 && s.lng <= 180;
              
              if (!isValid) {
                console.warn(`[koyo-stay] Invalid coordinates for spot "${s.name}" (${s.id}): lat=${s.lat}, lng=${s.lng}`);
              }
              
              return isValid;
            })
            .map((s: any) => {
              // 座標を数値型に明示的に変換
              const lat = Number(s.lat);
              const lng = Number(s.lng);
              
              return { lat, lng };
            })
        : [];
    
    response.routeInfo = {
      origin: KOYO_COORDINATES,
      waypoints,
      destination: KOYO_COORDINATES,
    };
    
    // デバッグログ：routeInfoの内容を確認
    console.log("[koyo-stay] routeInfo constructed:", {
      origin: response.routeInfo.origin,
      destination: response.routeInfo.destination,
      waypointsCount: response.routeInfo.waypoints.length,
      waypoints: response.routeInfo.waypoints,
    });

    response.debug = { branch: "stay:outdoor_plan" };
    return NextResponse.json(response);
  } catch (error: any) {
    console.error("[koyo-stay] ❌ BRANCH: outdoor_plan ERROR:", error);
    console.error("[koyo-stay] error:", error);
    return NextResponse.json(
      {
        error: "滞在中AIの応答生成中にエラーが発生しました。",
        detail: error?.message ?? String(error),
        reply: "申し訳ございません。エラーが発生しました。",
        plan: [],
        spots: [],
        routeInfo: null,
        debug: { branch: "stay:UNHANDLED_ERROR" },
      },
      { status: 500 }
    );
  }
}

/**
 * リクエストボディの型
 * - messages: chat履歴（フロントが管理）
 * - query: 単発問い合わせ
 * - gender: 性別（施設案内用、オプショナル）
 */
type StayRequestBody =
  | { messages: ChatCompletionMessageParam[]; gender?: "male" | "female" }
  | { query: string; gender?: "male" | "female" };

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as StayRequestBody;

    let userMessages: ChatCompletionMessageParam[];
    let userMessage: string;
    const gender = body.gender;

    if ("messages" in body && Array.isArray(body.messages)) {
      // フロントの履歴を採用
      userMessages = body.messages;
      // 最後のユーザーメッセージを取得
      const lastUserMessage = userMessages.filter((m) => m.role === "user").pop();
      userMessage = typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "";
    } else if ("query" in body && typeof body.query === "string") {
      // 単発問い合わせモード（MVP向け）
      userMessage = body.query;
      userMessages = [
        {
          role: "user",
          content: body.query,
        },
      ];
    } else {
      return NextResponse.json(
        { error: "messages または query が必要です。" },
        { status: 400 }
      );
    }

    // 分岐トレースログ：入力情報
    const normalizedMessage = userMessage.trim().toUpperCase();
    console.log("[koyo-stay] 🔍 BRANCH TRACE - Input:", {
      userMessageRaw: userMessage,
      userMessageNormalized: normalizedMessage,
      gender,
    });

    // Phase1.75: モード相違検出
    const modeMismatch = detectModeMismatch(userMessage, "stay");
    if (modeMismatch.detected) {
      console.log("[koyo-stay] ⚠️ MODE MISMATCH detected:", modeMismatch.reason);
      return NextResponse.json({
        reply: "その内容は、今お話ししている流れと少し異なりそうですね。どのタイミングのお話か、確認してもよろしいでしょうか？（チェックイン前／滞在中／チェックアウト後 など）",
        plan: [],
        spots: [],
        debug: { branch: "stay:mode_mismatch", mode_mismatch: true, reason: modeMismatch.reason },
      });
    }

    // ルーティング: detectStopIntent を最優先で評価（外出意図の判定）
    const stopIntent = detectStopIntent(userMessage);
    const isFacility = isFacilityQuery(userMessage);
    
    // 分岐トレースログ：判定結果
    console.log("[koyo-stay] 🔍 BRANCH TRACE - Conditions:", {
      stopIntent: stopIntent ? { type: stopIntent.type, foodCategory: stopIntent.foodCategory } : null,
      isFacilityQuery: isFacility,
    });
    
    if (stopIntent) {
      // 外出プランとして処理（温泉・ランチ・カフェなど）
      console.log("[koyo-stay] ✅ BRANCH: outdoor_plan (stopIntent detected)");
      return handleStayPlanner(userMessages);
    } else if (isFacility) {
      // 館内施設案内（利用情報の問い合わせ）
      console.log("[koyo-stay] ✅ BRANCH: facility_query (isFacilityQuery=true)");
      return handleFacilityOperation(userMessages, gender);
    } else {
      // デフォルトは外出プラン
      console.log("[koyo-stay] ✅ BRANCH: default_plan (fallback)");
      return handleStayPlanner(userMessages);
    }
  } catch (error: any) {
    console.error("[koyo-stay] error:", error);
    return NextResponse.json(
      {
        error: "滞在中AIの応答生成中にエラーが発生しました。",
        detail: error?.message ?? String(error),
        reply: "申し訳ございません。エラーが発生しました。",
        plan: [],
        spots: [],
        routeInfo: null,
      },
      { status: 500 }
    );
  }
}
